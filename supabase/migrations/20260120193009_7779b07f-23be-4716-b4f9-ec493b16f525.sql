-- Fix Groq key checkout functions to cast TEXT job id into UUID for api_keys.locked_by_job_id

CREATE OR REPLACE FUNCTION public.checkout_groq_key_for_stt(
  p_job_id text,
  p_lock_duration_seconds integer DEFAULT 300,
  p_part_number integer DEFAULT 1
)
RETURNS TABLE(out_key_id text, out_key_value text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Lock the key (api_keys.locked_by_job_id is UUID)
  UPDATE public.api_keys
  SET locked_by_job_id = p_job_id::uuid,
      locked_until = now() + (p_lock_duration_seconds || ' seconds')::interval,
      updated_at = now()
  WHERE id = v_key_row.id;

  RETURN QUERY SELECT v_key_row.id::text, v_key_row.key_value;
END;
$function$;

CREATE OR REPLACE FUNCTION public.checkout_groq_key_for_llm(
  p_job_id text,
  p_lock_duration_seconds integer DEFAULT 300,
  p_part_number integer DEFAULT 1
)
RETURNS TABLE(out_key_id text, out_key_value text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Lock the key (api_keys.locked_by_job_id is UUID)
  UPDATE public.api_keys
  SET locked_by_job_id = p_job_id::uuid,
      locked_until = now() + (p_lock_duration_seconds || ' seconds')::interval,
      updated_at = now()
  WHERE id = v_key_row.id;

  RETURN QUERY SELECT v_key_row.id::text, v_key_row.key_value;
END;
$function$;