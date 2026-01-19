import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { uploadToR2 } from "../_shared/r2Client.ts";
import { corsHeaders } from "../_shared/speakingUtils.ts";

/**
 * REFACTORED Speaking Evaluation - "Receptionist" Role
 * 
 * This function NO LONGER calls Gemini directly. Instead it:
 * 1. Validates the request and creates a job record
 * 2. Returns jobId immediately (instant UX)
 * 3. Uses EdgeRuntime.waitUntil() to upload audio to R2 in background
 * 4. Triggers speaking-upload-job after R2 upload completes
 * 
 * This provides instant response time while evaluation happens in background.
 */

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

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

interface AudioDataInput {
  [key: string]: string; // segmentKey -> base64 data URL
}

serve(async (req) => {
  console.log(`[evaluate-speaking-parallel] RECEPTIONIST mode - Request at ${new Date().toISOString()}`);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  try {
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
    });

    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { testId, audioData, durations, topic, difficulty, fluencyFlag } = await req.json() as {
      testId: string;
      audioData: AudioDataInput;
      durations?: Record<string, number>;
      topic?: string;
      difficulty?: string;
      fluencyFlag?: boolean;
    };

    if (!testId || !audioData || Object.keys(audioData).length === 0) {
      return new Response(JSON.stringify({ error: 'Missing testId or audioData', code: 'BAD_REQUEST' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const audioKeys = Object.keys(audioData);
    console.log(`[evaluate-speaking-parallel] ${audioKeys.length} audio segments for test ${testId}`);

    // =========================================================================
    // STEP 1: Create job record immediately and return jobId
    // =========================================================================
    
    // Cancel any existing pending/processing jobs for this test
    await supabaseService
      .from('speaking_evaluation_jobs')
      .update({
        status: 'failed',
        stage: 'cancelled',
        last_error: 'Superseded by new submission',
        updated_at: new Date().toISOString(),
      })
      .eq('test_id', testId)
      .eq('user_id', user.id)
      .in('status', ['pending', 'processing']);

    // Create new job record
    const { data: jobRow, error: jobError } = await supabaseService
      .from('speaking_evaluation_jobs')
      .insert({
        user_id: user.id,
        test_id: testId,
        status: 'pending',
        stage: 'pending_upload',
        file_paths: {}, // Will be populated after R2 upload
        durations: durations || {},
        topic: topic || null,
        difficulty: difficulty || null,
        fluency_flag: fluencyFlag || false,
        total_parts: 3,
        current_part: 0,
        progress: 0,
        retry_count: 0,
        max_retries: 5,
      })
      .select('id')
      .single();

    if (jobError || !jobRow) {
      console.error('[evaluate-speaking-parallel] Failed to create job:', jobError);
      return new Response(JSON.stringify({ error: 'Failed to create evaluation job', code: 'JOB_CREATE_FAILED' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const jobId = jobRow.id;
    console.log(`[evaluate-speaking-parallel] Created job ${jobId}, returning immediately`);

    // =========================================================================
    // STEP 2: Start background R2 upload (non-blocking)
    // =========================================================================
    const backgroundTask = async () => {
      console.log(`[evaluate-speaking-parallel] Background task starting for job ${jobId}`);
      const r2FilePaths: Record<string, string> = {};
      
      try {
        // Upload all audio segments to R2
        for (const segmentKey of audioKeys) {
          try {
            const { mimeType, base64 } = parseDataUrl(audioData[segmentKey]);
            if (!base64 || base64.length < 100) {
              console.log(`[evaluate-speaking-parallel] Skipping ${segmentKey} - too small`);
              continue;
            }

            const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'webm';
            const r2Key = `speaking-audios/parallel/${user.id}/${testId}/${segmentKey}.${ext}`;

            const result = await uploadToR2(r2Key, audioBytes, mimeType);
            if (result.success && result.url) {
              r2FilePaths[segmentKey] = r2Key;
              console.log(`[evaluate-speaking-parallel] Uploaded: ${segmentKey}`);
            } else {
              console.warn(`[evaluate-speaking-parallel] Upload failed for ${segmentKey}:`, result.error);
            }
          } catch (err) {
            console.error(`[evaluate-speaking-parallel] Upload error for ${segmentKey}:`, err);
          }
        }

        console.log(`[evaluate-speaking-parallel] R2 upload complete: ${Object.keys(r2FilePaths).length} files`);

        if (Object.keys(r2FilePaths).length === 0) {
          // All uploads failed
          await supabaseService
            .from('speaking_evaluation_jobs')
            .update({
              status: 'failed',
              stage: 'failed',
              last_error: 'All audio uploads to R2 failed',
              updated_at: new Date().toISOString(),
            })
            .eq('id', jobId);
          return;
        }

        // Update job with file paths and advance to pending_upload stage
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            file_paths: r2FilePaths,
            stage: 'pending_upload',
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);

        // Trigger speaking-upload-job to handle Google File API upload
        const uploadJobUrl = `${supabaseUrl}/functions/v1/speaking-upload-job`;
        console.log(`[evaluate-speaking-parallel] Triggering speaking-upload-job for ${jobId}`);
        
        const triggerResponse = await fetch(uploadJobUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ jobId }),
        });

        if (!triggerResponse.ok) {
          const errorText = await triggerResponse.text().catch(() => 'Unknown error');
          console.error(`[evaluate-speaking-parallel] Failed to trigger upload job: ${errorText}`);
        } else {
          console.log(`[evaluate-speaking-parallel] Upload job triggered successfully`);
        }

      } catch (err) {
        console.error(`[evaluate-speaking-parallel] Background task error:`, err);
        
        // Update job with error
        await supabaseService
          .from('speaking_evaluation_jobs')
          .update({
            status: 'failed',
            stage: 'failed',
            last_error: `Background upload failed: ${err instanceof Error ? err.message : String(err)}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }
    };

    // Use EdgeRuntime.waitUntil for background processing
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(backgroundTask());
    } else {
      // Fallback: fire and forget (less ideal but works)
      backgroundTask().catch(e => console.error('[evaluate-speaking-parallel] Background task failed:', e));
    }

    // =========================================================================
    // STEP 3: Return jobId immediately (instant UX)
    // =========================================================================
    return new Response(JSON.stringify({ 
      success: true,
      jobId,
      status: 'queued',
      message: 'Evaluation job created. Check history for progress.',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[evaluate-speaking-parallel] Error:', (error as Error)?.message);
    return new Response(JSON.stringify({ error: (error as Error)?.message || 'Unexpected error', code: 'UNKNOWN_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
