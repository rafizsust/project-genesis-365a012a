-- Fix the checkout_key_for_part function to avoid ambiguous column reference
-- The issue is that RETURN QUERY SELECT with a RETURNS TABLE can cause ambiguity
-- when the select list values have similar names to the return columns.
-- We fix this by explicitly aliasing the columns in the RETURN QUERY.

CREATE OR REPLACE FUNCTION public.checkout_key_for_part(
  p_job_id uuid, 
  p_part_number smallint, 
  p_lock_duration_seconds integer DEFAULT 120, 
  p_model_name text DEFAULT 'gemini-2.5-flash'::text
)
RETURNS TABLE(key_id uuid, key_value text, is_user_key boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_found_key_id uuid;
  v_found_key_value text;
  v_now timestamptz := now();
  v_release_at timestamptz;
BEGIN
  v_release_at := v_now + (p_lock_duration_seconds || ' seconds')::interval;
  
  -- Find an available key that is:
  -- 1. Active
  -- 2. Not rate-limited (rate_limited_until < now or null)
  -- 3. Not currently locked by another job (no active lock or lock expired)
  -- 4. Not daily quota exhausted for this model
  SELECT ak.id, ak.key_value
  INTO v_found_key_id, v_found_key_value
  FROM api_keys ak
  WHERE ak.is_active = true
    AND ak.provider = 'gemini'
    -- Not rate limited
    AND (ak.rate_limited_until IS NULL OR ak.rate_limited_until < v_now)
    -- Not daily quota exhausted (check the model-specific column)
    AND CASE 
      WHEN p_model_name = 'gemini-2.5-flash' THEN 
        (ak.gemini_2_5_flash_exhausted IS NULL OR ak.gemini_2_5_flash_exhausted = false 
         OR ak.gemini_2_5_flash_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-2.5-pro' THEN
        (ak.gemini_2_5_pro_exhausted IS NULL OR ak.gemini_2_5_pro_exhausted = false
         OR ak.gemini_2_5_pro_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-2.5-flash-tts' THEN
        (ak.gemini_2_5_flash_tts_exhausted IS NULL OR ak.gemini_2_5_flash_tts_exhausted = false
         OR ak.gemini_2_5_flash_tts_exhausted_date < CURRENT_DATE)
      WHEN p_model_name = 'gemini-3-pro' THEN
        (ak.gemini_3_pro_exhausted IS NULL OR ak.gemini_3_pro_exhausted = false
         OR ak.gemini_3_pro_exhausted_date < CURRENT_DATE)
      ELSE true
    END
    -- Not currently locked (check api_key_locks table)
    AND NOT EXISTS (
      SELECT 1 FROM api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.released_at IS NULL
        AND akl.release_at > v_now
    )
    -- Also check if there's a cooldown from a recent release
    AND NOT EXISTS (
      SELECT 1 FROM api_key_locks akl
      WHERE akl.key_id = ak.id
        AND akl.cooldown_until IS NOT NULL
        AND akl.cooldown_until > v_now
    )
  ORDER BY ak.error_count ASC, ak.consecutive_429_count ASC
  LIMIT 1
  FOR UPDATE OF ak SKIP LOCKED;
  
  IF v_found_key_id IS NULL THEN
    -- No available key found
    RETURN;
  END IF;
  
  -- Create the lock record
  INSERT INTO api_key_locks (key_id, job_id, part_number, locked_at, release_at)
  VALUES (v_found_key_id, p_job_id, p_part_number, v_now, v_release_at)
  ON CONFLICT (key_id, job_id, part_number) 
  DO UPDATE SET 
    locked_at = v_now,
    release_at = v_release_at,
    released_at = NULL,
    cooldown_until = NULL;
  
  -- Return using explicit column assignment to avoid ambiguity
  key_id := v_found_key_id;
  key_value := v_found_key_value;
  is_user_key := false;
  RETURN NEXT;
END;
$function$;