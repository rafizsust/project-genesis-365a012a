-- Add evaluation timing column to ai_practice_results table
-- This stores timing breakdown for how long evaluation took, persisting across devices

ALTER TABLE public.ai_practice_results 
ADD COLUMN IF NOT EXISTS evaluation_timing jsonb DEFAULT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN public.ai_practice_results.evaluation_timing IS 'Stores evaluation timing breakdown in milliseconds: { totalTimeMs, timing: { auth, downloadAudio, evaluate, saveResult, etc. } }';