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
 * Text-Based Speaking Evaluation - SIMPLIFIED
 * Receives raw transcripts from browser Web Speech API.
 * No word confidence or prosody metrics - just evaluates the transcript content.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODELS = ['gemini-2.5-flash'];

interface TranscriptData {
  rawTranscript: string;
  durationMs: number;
  browserMode?: string;
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

    const { data: testRow } = await supabaseService
      .from('ai_practice_tests')
      .select('payload, topic, difficulty')
      .eq('id', testId)
      .maybeSingle();

    const prompt = buildTextEvaluationPrompt(
      transcripts,
      topic || (testRow as any)?.topic || 'general',
      difficulty || (testRow as any)?.difficulty || 'medium',
      fluencyFlag || false,
      testRow?.payload
    );

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
    const durationSec = Math.round(d.durationMs / 1000);
    const wordCount = d.rawTranscript.split(/\s+/).filter(w => w.length > 0).length;
    const wpm = durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : 0;
    
    return `
### ${key.toUpperCase()}
Question: ${qInfo?.questionText || 'Unknown'}
Transcript: "${d.rawTranscript}"
Duration: ${durationSec}s | Words: ${wordCount} | WPM: ${wpm}`;
  }).join('\n');

  return `You are an IELTS Speaking examiner. Evaluate this candidate's responses based on the transcripts.

Topic: ${topic} | Difficulty: ${difficulty}
${fluencyFlag ? '⚠️ FLUENCY FLAG: Short Part 2 response (should be ~2 minutes)' : ''}

${segmentSummaries}

## IMPORTANT NOTES
- These transcripts are from browser speech recognition - they may have minor errors
- Base your evaluation on the CONTENT, vocabulary, and grammar visible in the text
- For pronunciation: You cannot hear audio, so base this on complexity of vocabulary used and assume average pronunciation (Band 6) unless content suggests otherwise

## OUTPUT (JSON only)
\`\`\`json
{
  "overall_band": 6.5,
  "criteria": {
    "fluency_coherence": { "band": 6.5, "feedback": "...", "strengths": [], "weaknesses": [] },
    "lexical_resource": { "band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [], "lexical_upgrades": [{"original": "good", "upgraded": "exceptional", "context": "..."}] },
    "grammatical_range": { "band": 6.0, "feedback": "...", "strengths": [], "weaknesses": [] },
    "pronunciation": { "band": 6.0, "feedback": "Estimated from text complexity", "strengths": [], "weaknesses": [] }
  },
  "improvement_priorities": ["...", "..."],
  "examiner_notes": "..."
}
\`\`\``;
}
