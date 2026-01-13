import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";

/**
 * Async Speaking Evaluation Edge Function
 * 
 * This function receives file paths from R2 (already uploaded by frontend),
 * downloads them, uploads to Google File API, and evaluates with Gemini.
 * 
 * The user does NOT wait - they get instant "submitted" feedback.
 * Evaluation happens in background and results are saved to DB.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Model priority: Gemini 2.0 Flash first (stable, high RPM), 2.5 Flash second, 1.5 Pro fallback
const GEMINI_MODELS_PRIORITY = [
  'gemini-2.0-flash',       // Primary: Stable, high RPM
  'gemini-2.5-flash',       // Secondary: Newer stable
  'gemini-1.5-pro',         // Fallback: More capable but slower
];

// Exponential backoff configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  retryableStatuses: [429, 503, 504],
};

interface ApiKeyRecord {
  id: string;
  key_value: string;
  is_active: boolean;
}

interface EvaluationRequest {
  testId: string;
  filePaths: Record<string, string>; // key -> R2 path (e.g., "part1-q1" -> "speaking/.../q1.webm")
  durations?: Record<string, number>;
  topic?: string;
  difficulty?: string;
  part2SpeakingDuration?: number;
  fluencyFlag?: boolean;
}

function classifyGeminiError(status: number, errorText: string): { isQuota: boolean; isRateLimit: boolean; isUnavailable: boolean } {
  const lower = errorText.toLowerCase();
  
  if (status === 429 || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return { isQuota: true, isRateLimit: false, isUnavailable: false };
  }
  
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { isQuota: false, isRateLimit: true, isUnavailable: false };
  }
  
  if (status === 503 || lower.includes('overloaded') || lower.includes('unavailable')) {
    return { isQuota: false, isRateLimit: false, isUnavailable: true };
  }
  
  return { isQuota: false, isRateLimit: false, isUnavailable: false };
}

serve(async (req) => {
  const startTime = Date.now();
  console.log(`[evaluate-speaking-async] Request received at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const appEncryptionKey = Deno.env.get('app_encryption_key');

    // Create client with user's auth
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Get user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      console.error('[evaluate-speaking-async] Auth error:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[evaluate-speaking-async] User: ${user.id}`);

    // Parse request
    const body: EvaluationRequest = await req.json();
    const { testId, filePaths, durations, topic, difficulty, part2SpeakingDuration, fluencyFlag } = body;

    if (!testId || !filePaths || Object.keys(filePaths).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or filePaths', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const fileKeys = Object.keys(filePaths);
    console.log(`[evaluate-speaking-async] Test: ${testId}, Files: ${fileKeys.length}`);

    // Build API key queue: [User Key (if exists), ...Admin Pool Keys]
    const keyQueue: { key: string; id: string | null; isUser: boolean }[] = [];

    // Try to get user's Gemini API key
    if (appEncryptionKey) {
      const { data: userSecret } = await supabaseClient
        .from('user_secrets')
        .select('encrypted_value')
        .eq('user_id', user.id)
        .eq('secret_name', 'GEMINI_API_KEY')
        .single();

      if (userSecret?.encrypted_value) {
        try {
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const keyData = encoder.encode(appEncryptionKey);
          const cryptoKey = await crypto.subtle.importKey(
            "raw",
            keyData.slice(0, 32),
            { name: "AES-GCM" },
            false,
            ["decrypt"],
          );

          const encryptedBytes = Uint8Array.from(atob(userSecret.encrypted_value), (c) => c.charCodeAt(0));
          const iv = encryptedBytes.slice(0, 12);
          const ciphertext = encryptedBytes.slice(12);

          const decryptedData = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            cryptoKey,
            ciphertext,
          );

          const userApiKey = decoder.decode(decryptedData);
          keyQueue.push({ key: userApiKey, id: null, isUser: true });
          console.log('[evaluate-speaking-async] User API key added to queue');
        } catch (e) {
          console.error('[evaluate-speaking-async] Failed to decrypt user key:', e);
        }
      }
    }

    // Add admin pool keys
    const adminKeys = await getActiveGeminiKeysForModel(supabaseService, 'flash');
    for (const ak of adminKeys) {
      keyQueue.push({ key: ak.key_value, id: ak.id, isUser: false });
    }

    console.log(`[evaluate-speaking-async] Key queue: ${keyQueue.length} keys (user: ${keyQueue.filter(k => k.isUser).length})`);

    if (keyQueue.length === 0) {
      return new Response(JSON.stringify({ 
        error: 'No Gemini API key available. Please add your key in Settings.', 
        code: 'NO_API_KEY' 
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load test content for context
    const { data: testRow } = await supabaseClient
      .from('ai_practice_tests')
      .select('payload, topic, difficulty, preset_id')
      .eq('id', testId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!testRow) {
      return new Response(JSON.stringify({ error: 'Test not found', code: 'NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let payload = testRow.payload as any || {};
    
    // If preset with empty payload, fetch from generated_test_audio
    if (testRow.preset_id && (!payload.speakingParts && !payload.part1)) {
      const { data: presetData } = await supabaseService
        .from('generated_test_audio')
        .select('content_payload')
        .eq('id', testRow.preset_id)
        .maybeSingle();
      
      if (presetData?.content_payload) {
        payload = presetData.content_payload;
      }
    }

    // Download audio files from R2
    console.log('[evaluate-speaking-async] Downloading files from R2...');
    const audioContents: { key: string; data: Uint8Array; mimeType: string }[] = [];
    
    for (const [key, path] of Object.entries(filePaths)) {
      try {
        const result = await getFromR2(path);
        if (result.success && result.bytes) {
          const ext = path.split('.').pop()?.toLowerCase() || 'webm';
          const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/webm';
          audioContents.push({ key, data: result.bytes, mimeType });
          console.log(`[evaluate-speaking-async] Downloaded: ${key} (${result.bytes.length} bytes)`);
        } else {
          console.error(`[evaluate-speaking-async] Failed to download ${key}: ${result.error}`);
        }
      } catch (e) {
        console.error(`[evaluate-speaking-async] Error downloading ${key}:`, e);
      }
    }

    if (audioContents.length === 0) {
      return new Response(JSON.stringify({ error: 'No audio files could be downloaded', code: 'DOWNLOAD_ERROR' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build evaluation prompt
    const speakingParts = extractSpeakingParts(payload, fileKeys);
    const prompt = buildEvaluationPrompt(speakingParts, topic || testRow.topic, difficulty || testRow.difficulty, fluencyFlag);

    // Atomic API Key Session Loop
    let evaluationResult: any = null;
    let usedModel: string | null = null;
    
    for (const candidate of keyQueue) {
      console.log(`[evaluate-speaking-async] Trying key (isUser: ${candidate.isUser})`);
      
      // Try each model in priority order
      for (const modelName of GEMINI_MODELS_PRIORITY) {
        console.log(`[evaluate-speaking-async] Attempting model: ${modelName}`);
        
        try {
          // Build inline audio parts for Gemini
          const inlineParts = audioContents.map(ac => ({
            inline_data: {
              mime_type: ac.mimeType,
              data: btoa(String.fromCharCode(...ac.data)),
            }
          }));

          const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(candidate.key)}`;
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 120000);
          
          const response = await fetch(GEMINI_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{
                role: 'user',
                parts: [
                  ...inlineParts,
                  { text: prompt },
                ],
              }],
              generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 6000,
                responseMimeType: 'application/json',
              },
            }),
          });
          
          clearTimeout(timeoutId);
          console.log(`[evaluate-speaking-async] ${modelName} response: ${response.status}`);

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`[evaluate-speaking-async] ${modelName} error (${response.status}):`, errorText.slice(0, 300));
            
            const errInfo = classifyGeminiError(response.status, errorText);
            
            if (errInfo.isQuota || errInfo.isRateLimit) {
              // Mark admin key as exhausted
              if (candidate.id) {
                await markKeyQuotaExhausted(supabaseService, candidate.id, 'flash');
                console.log(`[evaluate-speaking-async] Marked key ${candidate.id} as quota exhausted`);
              }
              break; // Try next key
            }
            
            if (errInfo.isUnavailable) {
              continue; // Try next model with same key
            }
            
            continue; // Try next model
          }

          const data = await response.json();
          const responseText = data?.candidates?.[0]?.content?.parts
            ?.map((p: any) => p?.text)
            .filter(Boolean)
            .join('\n');

          if (!responseText) {
            console.error(`[evaluate-speaking-async] No response text from ${modelName}`);
            continue;
          }

          evaluationResult = parseJsonFromResponse(responseText);
          if (evaluationResult) {
            usedModel = modelName;
            console.log(`[evaluate-speaking-async] Success with ${modelName}`);
            break;
          }
        } catch (err: any) {
          if (err.name === 'AbortError') {
            console.error(`[evaluate-speaking-async] Timeout with ${modelName}`);
          } else {
            console.error(`[evaluate-speaking-async] Error with ${modelName}:`, err.message);
          }
          continue;
        }
      }
      
      if (evaluationResult) break;
    }

    if (!evaluationResult) {
      console.error('[evaluate-speaking-async] All keys/models exhausted');
      return new Response(JSON.stringify({ 
        error: 'Evaluation failed. All API keys exhausted. Please try again later.', 
        code: 'ALL_KEYS_EXHAUSTED' 
      }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Calculate overall band
    const overallBand = calculateOverallBand(evaluationResult);
    const elapsed = Date.now() - startTime;
    console.log(`[evaluate-speaking-async] Completed in ${elapsed}ms, band: ${overallBand}`);

    // Save to ai_practice_results
    const { error: saveError } = await supabaseService
      .from('ai_practice_results')
      .upsert({
        test_id: testId,
        user_id: user.id,
        module: 'speaking',
        score: Math.round(overallBand * 10),
        band_score: overallBand,
        total_questions: audioContents.length,
        time_spent_seconds: Math.round(elapsed / 1000),
        question_results: evaluationResult,
        answers: filePaths,
        completed_at: new Date().toISOString(),
      }, {
        onConflict: 'test_id',
      });

    if (saveError) {
      console.error('[evaluate-speaking-async] Save error:', saveError);
    } else {
      console.log('[evaluate-speaking-async] Result saved successfully');
    }

    return new Response(JSON.stringify({
      success: true,
      overallBand,
      usedModel,
      elapsed,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[evaluate-speaking-async] Error:', error);
    return new Response(JSON.stringify({ 
      error: error.message || 'Evaluation failed', 
      code: 'EVALUATION_ERROR' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function extractSpeakingParts(payload: any, audioKeys: string[]): any[] {
  const parts: any[] = [];
  
  if (payload.speakingParts) {
    return payload.speakingParts;
  }
  
  for (const partKey of ['part1', 'part2', 'part3']) {
    const rawPart = payload[partKey];
    if (!rawPart) continue;
    
    const partNumber = parseInt(partKey.slice(4));
    const questions = Array.isArray(rawPart.questions)
      ? rawPart.questions.map((q: any, idx: number) => ({
          id: `q${idx + 1}`,
          question_number: idx + 1,
          question_text: typeof q === 'string' ? q : (q?.question_text ?? ''),
        }))
      : [];
    
    parts.push({
      part_number: partNumber,
      instruction: rawPart.instruction,
      cue_card_topic: rawPart.cue_card ?? rawPart.cue_card_topic,
      questions,
    });
  }
  
  return parts;
}

function buildEvaluationPrompt(parts: any[], topic?: string, difficulty?: string, fluencyFlag?: boolean): string {
  let prompt = `You are an expert IELTS Speaking examiner. Evaluate the candidate's speaking test audio recordings.\n\n`;
  prompt += `Topic: ${topic || 'General'}\n`;
  prompt += `Difficulty: ${difficulty || 'Medium'}\n\n`;
  
  prompt += `The audio files are provided in order. Evaluate each part according to IELTS criteria:\n`;
  prompt += `- Fluency and Coherence (FC)\n`;
  prompt += `- Lexical Resource (LR)\n`;
  prompt += `- Grammatical Range and Accuracy (GR)\n`;
  prompt += `- Pronunciation (PR)\n\n`;
  
  if (fluencyFlag) {
    prompt += `NOTE: The candidate spoke for less than 80 seconds in Part 2. Consider this for fluency assessment.\n\n`;
  }
  
  prompt += `Return your evaluation as JSON with this structure:\n`;
  prompt += `{
  "overall_band": 6.5,
  "criteria": {
    "fluency_coherence": { "band": 6.5, "feedback": "..." },
    "lexical_resource": { "band": 6.5, "feedback": "..." },
    "grammatical_range": { "band": 6.5, "feedback": "..." },
    "pronunciation": { "band": 6.5, "feedback": "..." }
  },
  "parts": [
    { "part_number": 1, "band": 6.5, "feedback": "..." }
  ],
  "summary": "Overall assessment...",
  "improvements": ["suggestion 1", "suggestion 2"]
}\n`;

  return prompt;
}

function parseJsonFromResponse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

function calculateOverallBand(result: any): number {
  if (result.overall_band) return result.overall_band;
  
  const criteria = result.criteria;
  if (!criteria) return 6.0;
  
  const scores = [
    criteria.fluency_coherence?.band,
    criteria.lexical_resource?.band,
    criteria.grammatical_range?.band,
    criteria.pronunciation?.band,
  ].filter(s => typeof s === 'number');
  
  if (scores.length === 0) return 6.0;
  
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round(avg * 2) / 2; // Round to nearest 0.5
}
