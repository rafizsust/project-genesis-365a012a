-- Add new columns for staged processing with heartbeat and locking
-- These enable reliable, resumable, and timeout-proof speaking evaluations

-- Add stage column to track which stage the job is in
ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS stage text DEFAULT 'pending_upload';

-- Add heartbeat column - workers update this periodically during long operations
ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

-- Add lock columns for distributed processing safety
ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS lock_token text;

ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS lock_expires_at timestamptz;

-- Add column to store Google File API URIs (so uploads are idempotent)
ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS google_file_uris jsonb;

-- Track when upload completed successfully
ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS upload_completed_at timestamptz;

-- Track processing start time for timeout detection
ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

-- Add indexes for efficient watchdog queries
CREATE INDEX IF NOT EXISTS idx_speaking_jobs_status_stage 
ON public.speaking_evaluation_jobs (status, stage, updated_at);

CREATE INDEX IF NOT EXISTS idx_speaking_jobs_stuck 
ON public.speaking_evaluation_jobs (status, heartbeat_at) 
WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_speaking_jobs_pending_stage 
ON public.speaking_evaluation_jobs (status, stage, created_at) 
WHERE status = 'pending';

-- Add comment explaining the stages
COMMENT ON COLUMN public.speaking_evaluation_jobs.stage IS 
'Processing stage: pending_upload, uploading, pending_eval, evaluating, completed, failed';