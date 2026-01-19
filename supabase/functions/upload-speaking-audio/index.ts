import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { uploadToR2 } from "../_shared/r2Client.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface UploadRequest {
  testId: string;
  partNumber: 1 | 2 | 3;
  audioData: Record<string, string>; // key -> dataURL (e.g., "part1-q<id>" -> "data:audio/mp3;base64,...")
  updateResult?: boolean; // If true, also update the ai_practice_results record with audio URLs
}

serve(async (req) => {
  console.log('[upload-speaking-audio] Request received');
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Create client with user's auth
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    });

    // Get user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      console.error('[upload-speaking-audio] Auth error:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: UploadRequest = await req.json();
    const { testId, partNumber, audioData, updateResult } = body;

    if (!testId || !partNumber || !audioData) {
      return new Response(JSON.stringify({ error: 'Missing required fields', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const audioKeys = Object.keys(audioData);
    console.log(`[upload-speaking-audio] Uploading ${audioKeys.length} audio segments for Part ${partNumber}`);

    const uploadedUrls: Record<string, string> = {};
    const filePaths: Record<string, string> = {};

    for (const key of audioKeys) {
      try {
        const value = audioData[key];
        const { mimeType, base64 } = parseDataUrl(value);
        
        if (!base64 || base64.length < 1000) {
          console.log(`[upload-speaking-audio] Skipping ${key} - too small`);
          continue;
        }

        const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'webm';
        const r2Key = `speaking-audios/ai-speaking/${user.id}/${testId}/${key}.${ext}`;

        const result = await uploadToR2(r2Key, audioBytes, mimeType);
        if (result.success && result.url) {
          uploadedUrls[key] = result.url;
          filePaths[key] = r2Key;
          console.log(`[upload-speaking-audio] Uploaded: ${key}`);
        } else {
          console.warn(`[upload-speaking-audio] Upload failed for ${key}:`, result.error);
        }
      } catch (err) {
        console.error(`[upload-speaking-audio] Error uploading ${key}:`, err);
      }
    }

    console.log(`[upload-speaking-audio] Successfully uploaded ${Object.keys(uploadedUrls).length} files`);

    // If updateResult is true, also update the ai_practice_results record with audio URLs
    // This is used for text-based evaluation where audio is uploaded in background
    if (updateResult && Object.keys(uploadedUrls).length > 0) {
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseServiceKey) {
        const supabaseService = createClient(supabaseUrl, supabaseServiceKey);
        
        // Retry logic: result may not exist yet if evaluation is still processing
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 3000;
        
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          // Find the result for this test
          const { data: existingResult, error: findError } = await supabaseService
            .from('ai_practice_results')
            .select('id, answers')
            .eq('test_id', testId)
            .eq('user_id', user.id)
            .eq('module', 'speaking')
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          
          if (findError) {
            console.warn(`[upload-speaking-audio] Error finding result (attempt ${attempt + 1}):`, findError.message);
            break;
          }
          
          if (existingResult) {
            // Merge new audio URLs with existing ones
            const existingAnswers = (existingResult.answers || {}) as Record<string, any>;
            const existingAudioUrls = existingAnswers.audio_urls || {};
            const existingFilePaths = existingAnswers.file_paths || {};
            
            const mergedAudioUrls = { ...existingAudioUrls, ...uploadedUrls };
            const mergedFilePaths = { ...existingFilePaths, ...filePaths };
            
            const { error: updateError } = await supabaseService
              .from('ai_practice_results')
              .update({
                answers: {
                  ...existingAnswers,
                  audio_urls: mergedAudioUrls,
                  file_paths: mergedFilePaths,
                }
              })
              .eq('id', existingResult.id);
            
            if (updateError) {
              console.warn(`[upload-speaking-audio] Error updating result:`, updateError.message);
            } else {
              console.log(`[upload-speaking-audio] Updated ai_practice_results ${existingResult.id} with ${Object.keys(uploadedUrls).length} audio URLs`);
            }
            break; // Success - exit retry loop
          } else {
            // Result not found yet - wait and retry
            if (attempt < MAX_RETRIES - 1) {
              console.log(`[upload-speaking-audio] No result found for test ${testId}, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            } else {
              console.log(`[upload-speaking-audio] No result found for test ${testId} after ${MAX_RETRIES} attempts - audio URLs stored but not linked to result`);
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      uploadedUrls,
      filePaths,
      partNumber,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[upload-speaking-audio] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Upload failed';
    return new Response(JSON.stringify({ error: errorMessage, code: 'UPLOAD_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function parseDataUrl(value: string): { mimeType: string; base64: string } {
  if (!value) return { mimeType: 'audio/webm', base64: '' };

  if (value.startsWith('data:')) {
    const commaIdx = value.indexOf(',');
    const header = commaIdx >= 0 ? value.slice(5, commaIdx) : value.slice(5);
    const base64 = commaIdx >= 0 ? value.slice(commaIdx + 1) : '';

    const semiIdx = header.indexOf(';');
    const mimeType = (semiIdx >= 0 ? header.slice(0, semiIdx) : header).trim() || 'audio/webm';

    return { mimeType, base64 };
  }

  return { mimeType: 'audio/webm', base64: value };
}
