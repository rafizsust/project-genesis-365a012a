import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GoogleAIFileManager } from "https://esm.sh/@google/generative-ai@0.21.0/server";
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.21.0";
import { 
  getActiveGeminiKeysForModel, 
  markKeyQuotaExhausted,
  isQuotaExhaustedError
} from "../_shared/apiKeyQuotaUtils.ts";
import { getFromR2 } from "../_shared/r2Client.ts";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gemini-api-key',
};

// ============================================================================
// CREDIT SYSTEM - Cost Map and Daily Limits
// ============================================================================
const COSTS = {
  'generate_speaking': 5,
  'generate_writing': 5,
  'generate_listening': 20,
  'generate_reading': 20,
  'evaluate_speaking': 15,
  'evaluate_writing': 10,
  'evaluate_reading': 0,
  'evaluate_listening': 0,
  'explain_answer': 2
};

const DAILY_CREDIT_LIMIT = 100;

// DB-managed API key interface
interface ApiKeyRecord {
  id: string;
  provider: string;
  key_value: string;
  is_active: boolean;
  error_count: number;
}

// Model priority: Gemini 2.0 Flash first (stable, high RPM), 2.5 Flash second, 1.5 Pro fallback
const GEMINI_MODELS = [
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

// Custom error class for quota exhaustion
class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

// Check credits (returns error if limit reached)
async function checkCredits(
  serviceClient: any, 
  userId: string, 
  operationType: keyof typeof COSTS
): Promise<{ ok: boolean; error?: string }> {
  const cost = COSTS[operationType] || 0;
  if (cost === 0) return { ok: true };
  
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('daily_credits_used, last_reset_date')
      .eq('id', userId)
      .single();
    
    if (!profile) return { ok: true };
    
    let currentCreditsUsed = profile.daily_credits_used || 0;
    if (profile.last_reset_date !== today) {
      currentCreditsUsed = 0;
      await serviceClient
        .from('profiles')
        .update({ daily_credits_used: 0, last_reset_date: today })
        .eq('id', userId);
    }
    
    if (currentCreditsUsed + cost > DAILY_CREDIT_LIMIT) {
      return { 
        ok: false, 
        error: `Daily credit limit reached (${currentCreditsUsed}/${DAILY_CREDIT_LIMIT}). Add your own Gemini API key in Settings.`
      };
    }
    
    return { ok: true };
  } catch (err) {
    console.error('Error in credit check:', err);
    return { ok: true };
  }
}

// Deduct credits after successful operation
async function deductCredits(serviceClient: any, userId: string, operationType: keyof typeof COSTS): Promise<void> {
  const cost = COSTS[operationType] || 0;
  if (cost === 0) return;
  
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('daily_credits_used, last_reset_date')
      .eq('id', userId)
      .single();
    
    if (!profile) return;
    
    let currentCreditsUsed = profile.daily_credits_used || 0;
    if (profile.last_reset_date !== today) {
      currentCreditsUsed = 0;
    }
    
    await serviceClient
      .from('profiles')
      .update({ daily_credits_used: currentCreditsUsed + cost, last_reset_date: today })
      .eq('id', userId);
    
    console.log(`Deducted ${cost} credits for ${operationType}. New total: ${currentCreditsUsed + cost}/${DAILY_CREDIT_LIMIT}`);
  } catch (err) {
    console.error('Failed to deduct credits:', err);
  }
}

// Download audio from R2 and save to temp storage
async function downloadAudioFromR2(filePath: string): Promise<{ tempPath: string; mimeType: string }> {
  console.log(`[evaluate-speaking] Downloading from R2: ${filePath}`);
  
  const result = await getFromR2(filePath);
  if (!result.success || !result.bytes) {
    throw new Error(`Failed to download audio from R2: ${result.error}`);
  }
  
  const tempPath = `/tmp/${crypto.randomUUID()}.webm`;
  await Deno.writeFile(tempPath, result.bytes);
  
  console.log(`[evaluate-speaking] Saved to temp: ${tempPath} (${result.bytes.length} bytes)`);
  return { tempPath, mimeType: result.contentType || 'audio/webm' };
}

// Build the evaluation prompt
function buildEvaluationPrompt(test: any, questionGroups: any[], fileUris: { uri: string; mimeType: string; key: string }[]): any[] {
  const contents: any[] = [];

  // Initial instruction for Gemini
  contents.push({
    role: 'user',
    parts: [{
      text: `You are an OFFICIAL IELTS Speaking examiner following the Cambridge/British Council 2025 assessment standards. Your task is to evaluate the candidate's speaking performance using the EXACT official IELTS Band Descriptors.

    It is CRUCIAL that you:
    1. Listen carefully to the actual audio recordings
    2. Score STRICTLY according to official IELTS criteria - DO NOT inflate scores
    3. If audio is silent or has no speech, score 0 for all criteria
    
    **When providing feedback, use markdown for emphasis.**

    ---
    **IELTS Speaking Test: ${test.name}**
    ${test.description ? `Description: ${test.description}` : ''}
    ---

    === OFFICIAL IELTS BAND DESCRIPTORS (Apply Strictly) ===
    
    FLUENCY AND COHERENCE:
    - Band 9: Speaks fluently with only very occasional repetition; develops topics fully and appropriately
    - Band 7: Speaks at length without noticeable effort; uses a range of connectives with flexibility
    - Band 5: Usually maintains flow but uses repetition/self-correction; over-uses certain connectives
    - Band 3: Speaks with long pauses; limited ability to link sentences
    - Band 0: No speech detected
    
    LEXICAL RESOURCE:
    - Band 9: Uses vocabulary with full flexibility and precision; idiomatic language naturally
    - Band 7: Uses vocabulary flexibly; some less common/idiomatic vocabulary with awareness of style
    - Band 5: Manages familiar/unfamiliar topics but limited flexibility; mixed paraphrase success
    - Band 3: Simple vocabulary for personal info; insufficient for unfamiliar topics
    - Band 0: No speech detected
    
    GRAMMATICAL RANGE AND ACCURACY:
    - Band 9: Full range of structures naturally; consistently accurate
    - Band 7: Range of complex structures with flexibility; frequently error-free sentences
    - Band 5: Basic sentence forms with reasonable accuracy; complex structures contain errors
    - Band 3: Attempts basic forms with limited success; numerous errors
    - Band 0: No speech detected
    
    PRONUNCIATION:
    - Band 9: Full range of features with precision; effortless to understand
    - Band 7: Wide range of features; easy to understand; minimal L1 interference
    - Band 5: Mixed control of features; generally understood but mispronunciations occur
    - Band 3: Limited features; frequent mispronunciations cause difficulty
    - Band 0: No speech detected
    
    === SCORING RULES ===
    - Score each criterion INDEPENDENTLY based on the evidence
    - Most candidates score 5.0-7.0; Band 8+ requires exceptional performance
    - Overall band = arithmetic mean of 4 criteria, rounded to nearest 0.5
    - Minimal responses (1-3 words) = Max Band 3-4
    - No speech = Band 0
    `
    }]
  });

  // Add parts and questions with their corresponding audio file references
  questionGroups?.forEach(group => {
    contents.push({ role: 'user', parts: [{ text: `\n**Part ${group.part_number}: ${group.part_number === 1 ? 'Introduction and Interview' : group.part_number === 2 ? 'Individual Long Turn (Cue Card)' : 'Two-way Discussion'}**\n` }] });
    if (group.instruction) {
      contents.push({ role: 'user', parts: [{ text: `Instructions: "${group.instruction}"\n` }] });
    }

    if (group.part_number === 2) {
      if (group.cue_card_topic) contents.push({ role: 'user', parts: [{ text: `Cue Card Topic: "${group.cue_card_topic}"\n` }] });
      if (group.cue_card_content) contents.push({ role: 'user', parts: [{ text: `Cue Card Content: "${group.cue_card_content}"\n` }] });
      contents.push({ role: 'user', parts: [{ text: `Preparation Time: ${group.preparation_time_seconds} seconds, Speaking Time: ${group.speaking_time_seconds} seconds.\n` }] });
      
      const part2Question = group.speaking_questions?.[0];
      if (part2Question) {
        const audioKey = `part${group.part_number}-q${part2Question.id}`;
        const fileRef = fileUris.find(f => f.key === audioKey);
        
        if (fileRef) {
          contents.push({ role: 'user', parts: [{ text: `Your Audio Response for Part 2 (Topic: "${part2Question.question_text}"):\n` }] });
          contents.push({ role: 'user', parts: [{ fileData: { mimeType: fileRef.mimeType, fileUri: fileRef.uri } }] });
          contents.push({ role: 'user', parts: [{ text: `Please provide a transcript for the above audio for Part 2, using the key "${audioKey}" in the "transcripts" object of the final JSON output. If the audio is silent or contains no speech, indicate "No speech detected" and give a band score of 0 for that part.` }] });
        } else {
          contents.push({ role: 'user', parts: [{ text: `You did not provide audio for Part 2. Score this as 0.\n` }] });
        }
      }
    } else {
      group.speaking_questions?.forEach((question: any) => {
        contents.push({ role: 'user', parts: [{ text: `\nQuestion ${question.question_number}: "${question.question_text}"\n` }] });
        const audioKey = `part${group.part_number}-q${question.id}`;
        const fileRef = fileUris.find(f => f.key === audioKey);
        
        if (fileRef) {
          contents.push({ role: 'user', parts: [{ text: `Your Audio Response for Question ${question.question_number}:\n` }] });
          contents.push({ role: 'user', parts: [{ fileData: { mimeType: fileRef.mimeType, fileUri: fileRef.uri } }] });
          contents.push({ role: 'user', parts: [{ text: `Please provide a transcript for the above audio for Question ${question.question_number}, using the key "${audioKey}" in the "transcripts" object of the final JSON output. If the audio is silent or contains no speech, indicate "No speech detected" and give a band score of 0 for that question.` }] });
        } else {
          contents.push({ role: 'user', parts: [{ text: `You did not provide audio for Question ${question.question_number}. Score this as 0.\n` }] });
        }
      });
    }
  });

  // Final evaluation request
  contents.push({
    role: 'user',
    parts: [{
      text: `\n---
    **Evaluation Criteria:**

    1.  **Fluency and Coherence**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in speaking smoothly, logically, and connecting ideas.
        -   **Weaknesses**: Areas where your pauses, repetition, or unclear connections could be improved.
        -   **Suggestions for Improvement**: Actionable advice to enhance your fluency and coherence.
    2.  **Lexical Resource**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in using a range of vocabulary accurately and appropriately.
        -   **Weaknesses**: Areas where your vocabulary could be more varied, precise, or natural.
        -   **Suggestions for Improvement**: Advice on expanding your vocabulary and using less common lexical items effectively.
    3.  **Grammatical Range and Accuracy**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in using a variety of grammatical structures accurately.
        -   **Weaknesses**: Common errors or areas where your grammatical control could be improved.
        -   **Suggestions for Improvement**: Advice to enhance your grammatical range and accuracy.
    4.  **Pronunciation**:
        -   **Band**: [0-9, in 0.5 increments]
        -   **Strengths**: What you did well in producing clear, understandable speech with appropriate intonation and stress.
        -   **Weaknesses**: Areas where your pronunciation, intonation, or stress patterns could be improved for clarity.
        -   **Suggestions for Improvement**: Advice to improve your pronunciation for better intelligibility.

    **Part-by-Part Analysis:**
    Provide a brief summary of performance for each part, highlighting specific strengths and weaknesses observed in that part.

    -   **Part 1: Introduction & Interview**
        -   **Summary**: Overall impression of Part 1.
        -   **Strengths**: Specific examples of good performance.
        -   **Weaknesses**: Specific areas for improvement.
    -   **Part 2: Individual Long Turn**
        -   **Topic Coverage**: How well the topic was addressed.
        -   **Organization Quality**: Structure and flow of the long turn.
        -   **Cue Card Fulfillment**: How well all parts of the cue card were covered.
    -   **Part 3: Two-way Discussion**
        -   **Depth of Discussion**: Ability to discuss abstract ideas and elaborate.
        -   **Question Notes**: Any specific observations on handling Part 3 questions.

    **Overall Recommendations:**
    -   **Improvement Recommendations**: A list of general actionable advice and strategies you can use to improve overall speaking.
    -   **Strengths to Maintain**: A list of key strengths you should continue to leverage.
    -   **Examiner Notes (Optional)**: Any additional general comments.

    Format your response as a JSON object with the following structure:
    {
      "overall_band": number,
      "evaluation_report": {
        "fluency_coherence": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "lexical_resource": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "grammatical_range_accuracy": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "pronunciation": {
          "band": number,
          "strengths": string,
          "weaknesses": string,
          "suggestions_for_improvement": string
        },
        "part_by_part_analysis": {
          "part1": {
            "summary": string,
            "strengths": string,
            "weaknesses": string
          },
          "part2": {
            "topic_coverage": string,
            "organization_quality": string,
            "cue_card_fulfillment": string
          },
          "part3": {
            "depth_of_discussion": string,
            "question_notes": string
          }
        },
        "improvement_recommendations": string[],
        "strengths_to_maintain": string[],
        "examiner_notes": string,
        "modelAnswers": [
          {"partNumber": number, "question": string, "candidateResponse": string, "modelAnswerBand6": string, "modelAnswerBand7": string, "modelAnswerBand8": string, "modelAnswerBand9": string, "whyBand6Works": string[], "whyBand7Works": string[], "whyBand8Works": string[], "whyBand9Works": string[]}
        ],
        "transcripts": {
          "part1-q[question_id_1]": "Transcript for Part 1 Question 1",
          "part1-q[question_id_2]": "Transcript for Part 1 Question 2",
          "part2-q[part2_question_id]": "Transcript for Part 2 long turn",
          "part3-q[question_id_1]": "Transcript for Part 3 Question 1"
        }
      }
    }
    
    CRITICAL MANDATORY REQUIREMENTS FOR MODEL ANSWERS:
    1. The "modelAnswers" array MUST contain an entry for EVERY question from ALL parts - NO EXCEPTIONS.
    2. Each entry MUST include ALL FOUR band levels: modelAnswerBand6, modelAnswerBand7, modelAnswerBand8, modelAnswerBand9.
    3. Each entry MUST include ALL FOUR whyBandXWorks arrays: whyBand6Works, whyBand7Works, whyBand8Works, whyBand9Works.
    4. NEVER skip or omit any band level - all four are MANDATORY for every question.
    5. If any band level is missing, the response will be REJECTED and must be regenerated.
    6. Each whyBandXWorks array should have 2-4 specific reasons.
    
    MANDATORY WORD COUNT REQUIREMENTS FOR MODEL ANSWERS (STRICT - REGARDLESS OF CANDIDATE RESPONSE LENGTH):
    - Part 1 model answers: 60-85 words per question (natural, conversational with examples)
    - Part 2 model answers: 260-340 words (comprehensive long turn with all cue card points covered)
    - Part 3 model answers: 130-170 words per question (in-depth discussion with reasoning and examples)
    These word counts are MINIMUM STANDARDS. Even if the candidate gave a very short response, YOUR model answers MUST meet these lengths.
    Model answers should demonstrate ideal response structure and vocabulary for each band level.
    
    Ensure your response is ONLY the JSON object, with no additional text or markdown formatting outside of the JSON itself.
    `
    }]
  });

  return contents;
}

// @ts-ignore
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // @ts-ignore
    const supabaseClient = createClient(
      // @ts-ignore
      (Deno.env.get('SUPABASE_URL') as string) ?? '',
      // @ts-ignore
      (Deno.env.get('SUPABASE_ANON_KEY') as string) ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { submissionId, filePaths } = await req.json();

    if (!submissionId || !filePaths) {
      console.error('Edge Function: Missing submissionId or filePaths in request body.');
      return new Response(JSON.stringify({ error: 'Missing submissionId or filePaths', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('[evaluate-speaking] Received filePaths:', Object.keys(filePaths));

    // 1. Fetch submission details
    const { data: submission, error: submissionError } = await supabaseClient
      .from('speaking_submissions')
      .select('test_id, user_id')
      .eq('id', submissionId)
      .eq('user_id', user.id)
      .single();

    if (submissionError || !submission) {
      return new Response(JSON.stringify({ error: submissionError?.message || 'Speaking submission not found or unauthorized.', code: 'SUBMISSION_NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Fetch the associated test details
    const { data: test, error: testError } = await supabaseClient
      .from('speaking_tests')
      .select('name, description')
      .eq('id', submission.test_id)
      .single();

    if (testError || !test) {
      return new Response(JSON.stringify({ error: testError?.message || 'Associated speaking test not found.', code: 'TEST_NOT_FOUND' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Fetch question groups and questions for context
    const { data: questionGroups, error: groupsError } = await supabaseClient
      .from('speaking_question_groups')
      .select('part_number, instruction, cue_card_topic, cue_card_content, time_limit_seconds, preparation_time_seconds, speaking_time_seconds, speaking_questions(question_number, question_text, order_index, id)')
      .eq('test_id', submission.test_id)
      .order('part_number')
      .order('order_index', { foreignTable: 'speaking_questions' });

    if (groupsError) {
      console.warn('Could not fetch question groups for speaking evaluation context:', groupsError.message);
    }

    // Service client for credit operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const appEncryptionKey = Deno.env.get('app_encryption_key');

    // ============ BUILD API KEY QUEUE (Atomic Session Logic) ============
    interface KeyCandidate {
      key: string;
      keyId: string | null;
      isUserProvided: boolean;
    }

    const keyQueue: KeyCandidate[] = [];

    // 1. Check for user-provided key (header or user_secrets)
    const headerApiKey = req.headers.get('x-gemini-api-key');
    if (headerApiKey) {
      keyQueue.push({ key: headerApiKey, keyId: null, isUserProvided: true });
    } else {
      const { data: userSecret } = await supabaseClient
        .from('user_secrets')
        .select('encrypted_value')
        .eq('user_id', user.id)
        .eq('secret_name', 'GEMINI_API_KEY')
        .single();

      if (userSecret && appEncryptionKey) {
        try {
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const keyData = encoder.encode(appEncryptionKey);
          const cryptoKey = await crypto.subtle.importKey("raw", keyData.slice(0, 32), { name: "AES-GCM" }, false, ["decrypt"]);
          const encryptedBytes = Uint8Array.from(atob(userSecret.encrypted_value), c => c.charCodeAt(0));
          const decryptedData = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encryptedBytes.slice(0, 12) }, cryptoKey, encryptedBytes.slice(12));
          const userKey = decoder.decode(decryptedData);
          keyQueue.push({ key: userKey, keyId: null, isUserProvided: true });
        } catch (e) {
          console.warn('[evaluate-speaking] Failed to decrypt user API key:', e);
        }
      }
    }

    // 2. Add admin keys from database
    const dbApiKeys = await getActiveGeminiKeysForModel(serviceClient, 'flash');
    for (const dbKey of dbApiKeys) {
      keyQueue.push({ key: dbKey.key_value, keyId: dbKey.id, isUserProvided: false });
    }

    if (keyQueue.length === 0) {
      return new Response(JSON.stringify({ error: 'No API key available. Please add your Gemini API key in Settings.', code: 'API_KEY_NOT_FOUND' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[evaluate-speaking] Key queue: ${keyQueue.length} keys (${keyQueue.filter(k => k.isUserProvided).length} user, ${keyQueue.filter(k => !k.isUserProvided).length} admin)`);

    // ============ DOWNLOAD FILES FROM R2 ============
    const tempFiles: { key: string; tempPath: string; mimeType: string }[] = [];
    
    try {
      for (const [audioKey, r2Path] of Object.entries(filePaths as Record<string, string>)) {
        const { tempPath, mimeType } = await downloadAudioFromR2(r2Path);
        tempFiles.push({ key: audioKey, tempPath, mimeType });
      }
      console.log(`[evaluate-speaking] Downloaded ${tempFiles.length} audio files to temp storage`);
    } catch (downloadError) {
      console.error('[evaluate-speaking] Failed to download audio files:', downloadError);
      return new Response(JSON.stringify({ error: 'Failed to download audio files', code: 'R2_DOWNLOAD_ERROR' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ============ ATOMIC SESSION EXECUTION LOOP ============
    let responseText: string | null = null;
    let usedModel: string | null = null;
    let usedKey: KeyCandidate | null = null;

    for (const candidateKey of keyQueue) {
      console.log(`[evaluate-speaking] Trying key ${candidateKey.isUserProvided ? '(user)' : `(admin: ${candidateKey.keyId})`}`);

      // Credit check for admin keys only
      if (!candidateKey.isUserProvided) {
        const creditCheck = await checkCredits(serviceClient, user.id, 'evaluate_speaking');
        if (!creditCheck.ok) {
          console.log(`[evaluate-speaking] Credit check failed for admin key, skipping...`);
          continue;
        }
      }

      try {
        // STEP 1: Upload files to Google File API (ATOMIC with this key)
        const fileManager = new GoogleAIFileManager(candidateKey.key);
        const fileUris: { uri: string; mimeType: string; key: string }[] = [];

        for (const tempFile of tempFiles) {
          try {
            const uploadResult = await fileManager.uploadFile(tempFile.tempPath, {
              mimeType: tempFile.mimeType,
              displayName: tempFile.key,
            });
            fileUris.push({ uri: uploadResult.file.uri, mimeType: tempFile.mimeType, key: tempFile.key });
            console.log(`[evaluate-speaking] Uploaded ${tempFile.key} to Google: ${uploadResult.file.uri}`);
          } catch (uploadError: any) {
            if (isQuotaExhaustedError(uploadError) || uploadError?.status === 429 || uploadError?.status === 403) {
              throw new QuotaError(`Upload quota exhausted: ${uploadError.message}`);
            }
            throw uploadError;
          }
        }

        // STEP 2: Generate content with the same key (ATOMIC)
        const genAI = new GoogleGenerativeAI(candidateKey.key);
        
        // Try each model in priority order
        for (const modelName of GEMINI_MODELS) {
          try {
            console.log(`[evaluate-speaking] Attempting evaluation with model: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName });
            
            const contents = buildEvaluationPrompt(test, questionGroups || [], fileUris);
            
            const result = await model.generateContent({
              contents,
            });

            const content = result.response?.text();
            if (content) {
              responseText = content;
              usedModel = modelName;
              usedKey = candidateKey;
              break; // Success with this model
            }
          } catch (modelError: any) {
            console.warn(`[evaluate-speaking] Model ${modelName} failed:`, modelError.message);
            
            if (isQuotaExhaustedError(modelError) || modelError?.status === 429 || modelError?.status === 403) {
              throw new QuotaError(`Generation quota exhausted: ${modelError.message}`);
            }
            
            // Continue to next model
            continue;
          }
        }

        if (responseText) break; // Success, exit key loop

      } catch (error: any) {
        if (error instanceof QuotaError) {
          console.warn(`[evaluate-speaking] Key ${candidateKey.keyId || 'user'} quota exhausted. Switching to next key...`);
          
          if (!candidateKey.isUserProvided && candidateKey.keyId) {
            await markKeyQuotaExhausted(serviceClient, candidateKey.keyId, 'flash');
          }
          
          continue; // Try next key
        }
        
        // Fatal error - throw
        console.error('[evaluate-speaking] Fatal error during evaluation:', error);
        throw error;
      }
    }

    // Cleanup temp files
    for (const tempFile of tempFiles) {
      try {
        await Deno.remove(tempFile.tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (!responseText || !usedModel || !usedKey) {
      throw new Error(JSON.stringify({ error: 'All API keys exhausted. Please try again later or add your own Gemini API key.', code: 'ALL_KEYS_EXHAUSTED' }));
    }

    console.log(`[evaluate-speaking] Successfully received response from model: ${usedModel}`);

    // Deduct credits for admin keys on success
    if (!usedKey.isUserProvided) {
      await deductCredits(serviceClient, user.id, 'evaluate_speaking');
    }

    // Parse response
    let evaluationReport: any;
    let overallBand: number | null = null;

    try {
      responseText = responseText.replace(/```json\n|\n```/g, '').trim();
      console.log('[evaluate-speaking] Cleaned Gemini response length:', responseText.length);

      const parsedResponse = JSON.parse(responseText);
      overallBand = parsedResponse.overall_band;
      
      // Normalize model answers in the evaluation report
      const rawReport = parsedResponse.evaluation_report || {};
      if (rawReport.modelAnswers && Array.isArray(rawReport.modelAnswers)) {
        const ensureArr = (val: any) => (Array.isArray(val) ? val : []);
        rawReport.modelAnswers = rawReport.modelAnswers.map((ma: any) => {
          const candidateResponse = ma.candidateResponse ?? ma.candidate_response ?? '';
          return {
            ...ma,
            partNumber: ma.partNumber ?? ma.part_number ?? 1,
            question: ma.question ?? '',
            candidateResponse,
            modelAnswerBand6: ma.modelAnswerBand6 ?? ma.model_answer_band6 ?? (candidateResponse || 'Model answer at Band 6 level.'),
            modelAnswerBand7: ma.modelAnswerBand7 ?? ma.model_answer_band7 ?? (candidateResponse || 'Model answer at Band 7 level.'),
            modelAnswerBand8: ma.modelAnswerBand8 ?? ma.model_answer_band8 ?? (candidateResponse || 'Model answer at Band 8 level.'),
            modelAnswerBand9: ma.modelAnswerBand9 ?? ma.model_answer_band9 ?? (candidateResponse || 'Model answer at Band 9 level.'),
            whyBand6Works: ensureArr(ma.whyBand6Works ?? ['Demonstrates competent language use']),
            whyBand7Works: ensureArr(ma.whyBand7Works ?? ['Shows good language control']),
            whyBand8Works: ensureArr(ma.whyBand8Works ?? ['Exhibits sophisticated vocabulary']),
            whyBand9Works: ensureArr(ma.whyBand9Works ?? ['Demonstrates near-native fluency']),
          };
        });
      }
      evaluationReport = rawReport;
    } catch (parseError) {
      console.error('Failed to parse Gemini JSON response:', parseError);
      evaluationReport = {
        raw_response: responseText,
        parse_error: 'Failed to parse full JSON from Gemini. Raw response provided.',
      };
      const bandMatch = responseText.match(/Overall Band Score:\s*(\d+(\.\d)?)/i);
      if (bandMatch && bandMatch[1]) {
        overallBand = parseFloat(bandMatch[1]);
      }
    }

    // Update submission with evaluation results
    const { error: updateError } = await supabaseClient
      .from('speaking_submissions')
      .update({
        evaluation_report: evaluationReport,
        overall_band: overallBand,
      })
      .eq('id', submissionId);

    if (updateError) throw updateError;

    // 8. Implement cleanup: Keep only the last 3 submissions for this user and speaking test
    const { data: userSubmissionsForTest, error: userSubmissionsError } = await supabaseClient
      .from('speaking_submissions')
      .select('id, submitted_at')
      .eq('user_id', user.id)
      .eq('test_id', submission.test_id)
      .order('submitted_at', { ascending: false });

    if (userSubmissionsError) {
      console.error('Error fetching user submissions for cleanup:', userSubmissionsError);
    } else if (userSubmissionsForTest) {
      const sortedAttemptTimestamps = Array.from(new Set(userSubmissionsForTest.map(sub => sub.submitted_at || '') as string[])).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

      if (sortedAttemptTimestamps.length > 3) {
        const timestampsToDelete = sortedAttemptTimestamps.slice(3);
        const submissionIdsToDelete: string[] = [];
        timestampsToDelete.forEach(ts => {
          userSubmissionsForTest.filter(sub => sub.submitted_at === ts).forEach(sub => submissionIdsToDelete.push(sub.id));
        });

        if (submissionIdsToDelete.length > 0) {
          const { error: deleteError } = await supabaseClient
            .from('speaking_submissions')
            .delete()
            .in('id', submissionIdsToDelete);

          if (deleteError) {
            console.error('Error deleting old submissions:', deleteError);
          } else {
            console.log(`Deleted ${submissionIdsToDelete.length} old speaking submissions for user ${user.id} and test ${submission.test_id}.`);
          }
        }
      }
    }

    return new Response(JSON.stringify({ message: 'Evaluation completed successfully', overallBand, evaluationReport }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Edge Function error:', error.message);
    let errorMessage = 'An unexpected error occurred during evaluation.';
    let errorCode = 'UNKNOWN_ERROR';
    try {
      const parsedError = JSON.parse(error.message);
      errorMessage = parsedError.error || errorMessage;
      errorCode = parsedError.code || errorCode;
    } catch (e) {
      errorMessage = error.message;
    }

    return new Response(JSON.stringify({ error: errorMessage, code: errorCode }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
