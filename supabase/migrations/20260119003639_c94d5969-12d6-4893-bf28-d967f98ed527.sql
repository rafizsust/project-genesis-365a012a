-- Add upload_api_key_id column to track which API key was used for Google File API upload
-- This is CRITICAL because Google File API files can only be accessed by the key that uploaded them

ALTER TABLE public.speaking_evaluation_jobs 
ADD COLUMN IF NOT EXISTS upload_api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL;

-- Add index for lookup
CREATE INDEX IF NOT EXISTS idx_speaking_jobs_upload_api_key 
ON public.speaking_evaluation_jobs(upload_api_key_id) WHERE upload_api_key_id IS NOT NULL;

COMMENT ON COLUMN public.speaking_evaluation_jobs.upload_api_key_id IS 
'The API key ID used to upload files to Google File API. Evaluation MUST use the same key since files are key-scoped.';