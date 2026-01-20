-- First, keep only the latest row in speaking_evaluation_settings
DELETE FROM public.speaking_evaluation_settings
WHERE id NOT IN (
  SELECT id FROM public.speaking_evaluation_settings
  ORDER BY updated_at DESC
  LIMIT 1
);

-- Add a unique constraint to ensure only one row can exist
-- We'll use a constant value pattern
ALTER TABLE public.speaking_evaluation_settings 
ADD COLUMN IF NOT EXISTS singleton_key TEXT DEFAULT 'default' NOT NULL;

-- Create unique constraint on singleton_key
ALTER TABLE public.speaking_evaluation_settings
DROP CONSTRAINT IF EXISTS speaking_evaluation_settings_singleton_key;

ALTER TABLE public.speaking_evaluation_settings
ADD CONSTRAINT speaking_evaluation_settings_singleton_key UNIQUE (singleton_key);

-- Update the get_speaking_evaluation_provider function to order by updated_at DESC
CREATE OR REPLACE FUNCTION public.get_speaking_evaluation_provider()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT provider FROM public.speaking_evaluation_settings
  ORDER BY updated_at DESC
  LIMIT 1;
$$;