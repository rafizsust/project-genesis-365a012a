-- Add separate quota tracking for Groq Whisper and LLM models
-- Currently only tracking combined ASH, need separate exhaustion flags

-- Whisper models quota tracking (already have groq_whisper_exhausted, but let's be more specific)
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS groq_whisper_v3_turbo_exhausted boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS groq_whisper_v3_turbo_exhausted_date timestamptz,
ADD COLUMN IF NOT EXISTS groq_llama_70b_exhausted boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS groq_llama_70b_exhausted_date timestamptz,
ADD COLUMN IF NOT EXISTS groq_stt_requests_this_minute integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS groq_stt_requests_minute_start timestamptz,
ADD COLUMN IF NOT EXISTS groq_llm_requests_this_minute integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS groq_llm_requests_minute_start timestamptz;

-- Update the mark_groq_key_exhausted function to handle specific models
CREATE OR REPLACE FUNCTION public.mark_groq_key_exhausted(
  p_key_id text,
  p_model text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.api_keys
  SET 
    groq_whisper_v3_turbo_exhausted = CASE 
      WHEN p_model IN ('whisper_v3_turbo', 'whisper-large-v3-turbo', 'whisper') THEN true 
      ELSE groq_whisper_v3_turbo_exhausted 
    END,
    groq_whisper_v3_turbo_exhausted_date = CASE 
      WHEN p_model IN ('whisper_v3_turbo', 'whisper-large-v3-turbo', 'whisper') THEN now() 
      ELSE groq_whisper_v3_turbo_exhausted_date 
    END,
    groq_llama_70b_exhausted = CASE 
      WHEN p_model IN ('llama_70b', 'llama-3.3-70b-versatile', 'llama') THEN true 
      ELSE groq_llama_70b_exhausted 
    END,
    groq_llama_70b_exhausted_date = CASE 
      WHEN p_model IN ('llama_70b', 'llama-3.3-70b-versatile', 'llama') THEN now() 
      ELSE groq_llama_70b_exhausted_date 
    END,
    -- Also set the generic flags for backward compatibility
    groq_whisper_exhausted = CASE 
      WHEN p_model IN ('whisper_v3_turbo', 'whisper-large-v3-turbo', 'whisper') THEN true 
      ELSE groq_whisper_exhausted 
    END,
    groq_whisper_exhausted_date = CASE 
      WHEN p_model IN ('whisper_v3_turbo', 'whisper-large-v3-turbo', 'whisper') THEN now() 
      ELSE groq_whisper_exhausted_date 
    END,
    groq_llama_exhausted = CASE 
      WHEN p_model IN ('llama_70b', 'llama-3.3-70b-versatile', 'llama') THEN true 
      ELSE groq_llama_exhausted 
    END,
    groq_llama_exhausted_date = CASE 
      WHEN p_model IN ('llama_70b', 'llama-3.3-70b-versatile', 'llama') THEN now() 
      ELSE groq_llama_exhausted_date 
    END,
    updated_at = now()
  WHERE id = p_key_id::uuid;
END;
$$;

-- Update checkout functions to check specific model exhaustion
CREATE OR REPLACE FUNCTION public.checkout_groq_key_for_stt(
  p_job_id text,
  p_lock_duration_seconds integer DEFAULT 300,
  p_part_number integer DEFAULT 1
)
RETURNS TABLE(out_key_id text, out_key_value text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_row RECORD;
BEGIN
  -- Find an available Groq key that isn't exhausted for Whisper
  SELECT id, key_value INTO v_key_row
  FROM public.api_keys
  WHERE provider = 'groq'
    AND is_active = true
    AND (groq_whisper_v3_turbo_exhausted IS NOT TRUE OR 
         groq_whisper_v3_turbo_exhausted_date < now() - interval '24 hours')
    AND (groq_whisper_exhausted IS NOT TRUE OR 
         groq_whisper_exhausted_date < now() - interval '24 hours')
    AND (groq_rpm_cooldown_until IS NULL OR groq_rpm_cooldown_until < now())
    AND (rate_limited_until IS NULL OR rate_limited_until < now())
  ORDER BY 
    groq_ash_used_this_hour NULLS FIRST,
    updated_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_key_row IS NULL THEN
    RETURN;
  END IF;

  -- Lock the key
  UPDATE public.api_keys
  SET locked_by_job_id = p_job_id,
      locked_until = now() + (p_lock_duration_seconds || ' seconds')::interval,
      updated_at = now()
  WHERE id = v_key_row.id;

  RETURN QUERY SELECT v_key_row.id::text, v_key_row.key_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.checkout_groq_key_for_llm(
  p_job_id text,
  p_lock_duration_seconds integer DEFAULT 300,
  p_part_number integer DEFAULT 1
)
RETURNS TABLE(out_key_id text, out_key_value text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_row RECORD;
BEGIN
  -- Find an available Groq key that isn't exhausted for LLM
  SELECT id, key_value INTO v_key_row
  FROM public.api_keys
  WHERE provider = 'groq'
    AND is_active = true
    AND (groq_llama_70b_exhausted IS NOT TRUE OR 
         groq_llama_70b_exhausted_date < now() - interval '24 hours')
    AND (groq_llama_exhausted IS NOT TRUE OR 
         groq_llama_exhausted_date < now() - interval '24 hours')
    AND (groq_rpm_cooldown_until IS NULL OR groq_rpm_cooldown_until < now())
    AND (rate_limited_until IS NULL OR rate_limited_until < now())
  ORDER BY updated_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_key_row IS NULL THEN
    RETURN;
  END IF;

  -- Lock the key
  UPDATE public.api_keys
  SET locked_by_job_id = p_job_id,
      locked_until = now() + (p_lock_duration_seconds || ' seconds')::interval,
      updated_at = now()
  WHERE id = v_key_row.id;

  RETURN QUERY SELECT v_key_row.id::text, v_key_row.key_value;
END;
$$;

-- Add function to reset specific Groq model quotas (for testing/admin)
CREATE OR REPLACE FUNCTION public.reset_groq_model_quotas(
  p_key_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_key_id IS NOT NULL THEN
    UPDATE public.api_keys
    SET groq_whisper_v3_turbo_exhausted = false,
        groq_whisper_v3_turbo_exhausted_date = NULL,
        groq_llama_70b_exhausted = false,
        groq_llama_70b_exhausted_date = NULL,
        groq_whisper_exhausted = false,
        groq_whisper_exhausted_date = NULL,
        groq_llama_exhausted = false,
        groq_llama_exhausted_date = NULL,
        groq_ash_used_this_hour = 0,
        groq_rpm_cooldown_until = NULL,
        updated_at = now()
    WHERE id = p_key_id::uuid;
  ELSE
    UPDATE public.api_keys
    SET groq_whisper_v3_turbo_exhausted = false,
        groq_whisper_v3_turbo_exhausted_date = NULL,
        groq_llama_70b_exhausted = false,
        groq_llama_70b_exhausted_date = NULL,
        groq_whisper_exhausted = false,
        groq_whisper_exhausted_date = NULL,
        groq_llama_exhausted = false,
        groq_llama_exhausted_date = NULL,
        groq_ash_used_this_hour = 0,
        groq_rpm_cooldown_until = NULL,
        updated_at = now()
    WHERE provider = 'groq';
  END IF;
END;
$$;