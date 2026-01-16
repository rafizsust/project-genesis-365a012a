import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModels, 
  markModelQuotaExhausted,
  isQuotaExhaustedError,
  isDailyQuotaExhaustedError 
} from "../_shared/apiKeyQuotaUtils.ts";
import { createPerformanceLogger } from "../_shared/performanceLogger.ts";

/**
 * Text-Based Speaking Evaluation
 * Receives transcripts + fluency/prosody metrics instead of audio.
 * ~95% cheaper than audio-based evaluation.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash']; // Only use 2.5-flash for speaking evaluation

interface TranscriptData {
  rawTranscript: string;
  cleanedTranscript: string;
  wordConfidences: Array<{ word: string; confidence: number; isFiller: boolean; isRepeat: boolean }>;
  fluencyMetrics: {
    wordsPerMinute: number;
    pauseCount: number;
    fillerCount: number;
    fillerRatio: number;
    repetitionCount: number;
    overallFluencyScore: number;
  };
  prosodyMetrics: {
    pitchVariation: number;
    stressEventCount: number;
    rhythmConsistency: number;
  };
  durationMs: number;
  overallClarityScore: number;
}

interface EvaluationRequest {
  testId: string;
  userId: string;
  transcripts: Record<string, TranscriptData>;
  topic?: string;
  difficulty?: string;
  fluencyFlag?: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body: EvaluationRequest = await req.json();
    const { testId, userId, transcripts, topic, difficulty, fluencyFlag } = body;

    if (!testId || !userId || !transcripts || Object.keys(transcripts).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking-text] Processing ${Object.keys(transcripts).length} segments for test ${testId}`);

    // Get test details
    const { data: testRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, topic, difficulty')
      .eq('id', testId)
      .maybeSingle();

    // Build evaluation prompt
    const prompt = buildTextEvaluationPrompt(
      transcripts,
      topic || (testRow as any)?.topic || 'general',
      difficulty || (testRow as any)?.difficulty || 'medium',
      fluencyFlag || false,
      testRow?.payload
    );

    // Get API keys
    const dbApiKeys = await getActiveGeminiKeysForModels(supabaseService, GEMINI_MODELS);
    if (dbApiKeys.length === 0) {
      throw new Error('No API keys available');
    }

    const perfLogger = createPerformanceLogger('evaluate_speaking');
    let result: any = null;

    for (const apiKey of dbApiKeys) {
      if (result) break;
      const genAI = new GoogleGenerativeAI(apiKey.key_value);

      for (const modelName of GEMINI_MODELS) {
        if (result) break;
        try {
          console.log(`[evaluate-speaking-text] Trying ${modelName}`);
          const callStart = Date.now();

          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
          });

          const response = await model.generateContent(prompt);
          const text = response.response?.text?.() || '';
          const responseTimeMs = Date.now() - callStart;

          if (!text) {
            await perfLogger.logError(modelName, 'Empty response', responseTimeMs, apiKey.id);
            continue;
          }

          const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            result = JSON.parse(jsonStr);
            await perfLogger.logSuccess(modelName, responseTimeMs, apiKey.id);
          } else {
            await perfLogger.logError(modelName, 'Failed to parse JSON', responseTimeMs, apiKey.id);
          }
        } catch (err: any) {
          const errMsg = String(err?.message || '');
          console.error(`[evaluate-speaking-text] Error with ${modelName}:`, errMsg);
          if (isQuotaExhaustedError(errMsg)) {
            await markModelQuotaExhausted(supabaseService, apiKey.id, modelName);
            if (isDailyQuotaExhaustedError(errMsg)) break;
          }
        }
      }
    }

    if (!result) throw new Error('All API keys exhausted');

    // Save results
    await supabaseService.from('ai_practice_results').upsert({
      user_id: userId,
      test_id: testId,
      module: 'speaking',
      band_score: result.overall_band || result.overallBand || 0,
      question_results: result,
      answers: { transcripts },
      completed_at: new Date().toISOString(),
    }, { onConflict: 'user_id,test_id' });

    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[evaluate-speaking-text] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function buildTextEvaluationPrompt(
  transcripts: Record<string, TranscriptData>,
  topic: string,
  difficulty: string,
  fluencyFlag: boolean,
  payload?: any
): string {
  const parts = Array.isArray(payload?.speakingParts) ? payload.speakingParts : [];
  const questionById = new Map<string, { partNumber: number; questionText: string }>();
  
  for (const p of parts) {
    for (const q of (p?.questions || [])) {
      questionById.set(String(q?.id), { partNumber: Number(p?.part_number), questionText: q?.question_text || '' });
    }
  }

  const segmentSummaries = Object.entries(transcripts).map(([key, d]) => {
    const match = key.match(/^part([123])-q(.+)$/);
    const qInfo = match ? questionById.get(match[2]) : null;
    
    // Calculate average word confidence
    const avgWordConfidence = d.wordConfidences.length > 0
      ? (d.wordConfidences.reduce((sum, w) => sum + w.confidence, 0) / d.wordConfidences.length).toFixed(0)
      : 0;
    
    // Find low confidence words
    const lowConfWords = d.wordConfidences
      .filter(w => w.confidence < 70)
      .map(w => `"${w.word}" (${w.confidence}%)`)
      .slice(0, 5)
      .join(', ') || 'None';
    
    return `
### ${key.toUpperCase()}
Question: ${qInfo?.questionText || 'Unknown'}
Transcript: "${d.rawTranscript}"
Duration: ${Math.round(d.durationMs / 1000)}s | WPM: ${d.fluencyMetrics.wordsPerMinute}
Fillers: ${d.fluencyMetrics.fillerCount} (${(d.fluencyMetrics.fillerRatio * 100).toFixed(1)}%) | Pauses: ${d.fluencyMetrics.pauseCount}
Clarity Score: ${d.overallClarityScore}% | Pitch Variation: ${d.prosodyMetrics.pitchVariation.toFixed(0)}%
Rhythm Consistency: ${d.prosodyMetrics.rhythmConsistency.toFixed(0)}%
Avg Word Confidence: ${avgWordConfidence}%
Low Confidence Words: ${lowConfWords}`;
  }).join('\n');

  return `You are an IELTS Speaking examiner. Evaluate this candidate's responses.

## DATA SOURCE
- Transcripts from browser speech recognition (Web Speech API)
- Fluency/prosody metrics from real-time audio analysis
- Word confidence from speech recognition stability tracking

Topic: ${topic} | Difficulty: ${difficulty}
${fluencyFlag ? '⚠️ FLUENCY FLAG: Short Part 2 response (should be ~2 minutes)' : ''}

${segmentSummaries}

## SCORING ADJUSTMENTS (CRITICAL)

1. **Grammar Bias:** The transcript is from AI Speech-to-Text which auto-corrects grammar.
   - Assume simple, error-free sentences are a result of auto-correct (Cap Grammar at Band 6.0).
   - ONLY award high Grammar scores (7+) if you see explicit Complex Structures (conditionals, passive voice, relative clauses, embedded clauses).
   - Look for: "If I had...", "...which was...", "Having done...", "It is believed that...", etc.

2. **Pronunciation Bias:** You cannot hear the audio.
   - Base pronunciation STRICTLY on "Word Confidence" and "Pitch Variation".
   - High Confidence (>80%) + High Pitch Variance (>40%) = Good Pronunciation (6.5-7+).
   - Medium Confidence (60-80%) + Medium Pitch = Average Pronunciation (5.5-6.5).
   - Low Confidence (<60%) OR Flat Pitch (<25%) = Poor Pronunciation (4.5-5.5).
   - Low confidence words listed above may indicate unclear pronunciation.

3. **Fluency Scoring:**
   - Use the measured WPM (120-180 is ideal for IELTS).
   - Penalize high filler ratio (>5%) and excessive pauses.
   - Rhythm consistency <50% indicates choppy delivery.

## OUTPUT (JSON only)
\`\`\`json
{
  "overall_band": 6.5,
  "criteria": {
    "fluency_coherence": { "band": 6.5, "feedback": "...", "strengths": [], "weaknesses": [], "based_on": "Measured: X WPM, Y pauses, Z% filler ratio" },
    "lexical_resource": { "band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "lexical_upgrades": [{"original": "good", "upgraded": "exceptional", "context": "..."}] },
    "grammatical_range": { "band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "complex_structures_found": ["...", "..."] },
    "pronunciation": { "band": 6.0, "feedback": "...", "disclaimer": "Estimated from speech recognition confidence and prosody", "based_on": "Avg confidence X%, Pitch variation Y%" }
  },
  "improvement_priorities": ["...", "..."],
  "examiner_notes": "..."
}
\`\`\``;
}
