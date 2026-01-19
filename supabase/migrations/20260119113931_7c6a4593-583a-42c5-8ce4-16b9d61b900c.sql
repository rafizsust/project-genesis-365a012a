-- ============================================================================
-- SPEAKING EVALUATION: PER-PART KEY ROTATION WITH RATE LIMIT COOLING
-- ============================================================================

-- Add rate limiting columns to api_keys table
ALTER TABLE public.api_keys 
ADD COLUMN IF NOT EXISTS rate_limited_until timestamptz,
ADD COLUMN IF NOT EXISTS last_429_at timestamptz,
ADD COLUMN IF NOT EXISTS consecutive_429_count integer DEFAULT 0;

-- Create index for faster rate limit checks
CREATE INDEX IF NOT EXISTS idx_api_keys_rate_limited 
ON public.api_keys(rate_limited_until) 
WHERE is_active = true AND provider = 'gemini';

-- ============================================================================
-- API KEY LOCKS TABLE - Fine-grained per-part locking
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.api_key_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid REFERENCES public.api_keys(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  part_number smallint NOT NULL CHECK (part_number BETWEEN 1 AND 3),
  locked_at timestamptz DEFAULT now(),
  release_at timestamptz NOT NULL,
  released_at timestamptz,
  cooldown_until timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(key_id, job_id, part_number)
);

-- Index for finding active locks efficiently
CREATE INDEX IF NOT EXISTS idx_key_locks_active 
ON public.api_key_locks(key_id, release_at) 
WHERE released_at IS NULL;

-- Index for cleanup of old locks
CREATE INDEX IF NOT EXISTS idx_key_locks_cleanup
ON public.api_key_locks(released_at)
WHERE released_at IS NOT NULL;

-- ============================================================================
-- FUNCTION: checkout_key_for_part
-- Atomically acquires an API key for a specific speaking part
-- ============================================================================

CREATE OR REPLACE FUNCTION public.checkout_key_for_part(
  p_job_id uuid,
  p_part_number smallint,
  p_lock_duration_seconds integer DEFAULT 120,
  p_model_name text DEFAULT 'gemini-2.5-flash'
) RETURNS TABLE(key_id uuid, key_value text, is_user_key boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_id uuid;
  v_key_value text;
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
  INTO v_key_id, v_key_value
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
  
  IF v_key_id IS NULL THEN
    RETURN;
  END IF;
  
  -- Create the lock record
  INSERT INTO api_key_locks (key_id, job_id, part_number, locked_at, release_at)
  VALUES (v_key_id, p_job_id, p_part_number, v_now, v_release_at)
  ON CONFLICT (key_id, job_id, part_number) 
  DO UPDATE SET 
    locked_at = v_now,
    release_at = v_release_at,
    released_at = NULL,
    cooldown_until = NULL;
  
  RETURN QUERY SELECT v_key_id, v_key_value, false::boolean;
END;
$$;

-- ============================================================================
-- FUNCTION: release_key_with_cooldown
-- Releases a key lock and sets a mandatory cooldown period
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_key_with_cooldown(
  p_job_id uuid,
  p_part_number smallint,
  p_cooldown_seconds integer DEFAULT 45
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_cooldown_until timestamptz;
BEGIN
  v_cooldown_until := v_now + (p_cooldown_seconds || ' seconds')::interval;
  
  UPDATE api_key_locks
  SET 
    released_at = v_now,
    cooldown_until = v_cooldown_until
  WHERE job_id = p_job_id 
    AND part_number = p_part_number
    AND released_at IS NULL;
END;
$$;

-- ============================================================================
-- FUNCTION: mark_key_rate_limited
-- Marks a key as rate-limited for cooling (5-10 min based on consecutive 429s)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mark_key_rate_limited(
  p_key_id uuid,
  p_cooldown_minutes integer DEFAULT 5
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_consecutive integer;
  v_actual_cooldown integer;
  v_now timestamptz := now();
BEGIN
  -- Get current consecutive count
  SELECT COALESCE(consecutive_429_count, 0) + 1
  INTO v_consecutive
  FROM api_keys WHERE id = p_key_id;
  
  -- Escalate cooldown based on consecutive 429s
  IF v_consecutive >= 3 THEN
    v_actual_cooldown := GREATEST(p_cooldown_minutes, 10);
  ELSE
    v_actual_cooldown := p_cooldown_minutes;
  END IF;
  
  UPDATE api_keys
  SET 
    rate_limited_until = v_now + (v_actual_cooldown || ' minutes')::interval,
    last_429_at = v_now,
    consecutive_429_count = v_consecutive,
    updated_at = v_now
  WHERE id = p_key_id;
  
  -- Also release any current locks for this key
  UPDATE api_key_locks
  SET 
    released_at = v_now,
    cooldown_until = v_now + (v_actual_cooldown || ' minutes')::interval
  WHERE key_id = p_key_id
    AND released_at IS NULL;
END;
$$;

-- ============================================================================
-- FUNCTION: reset_key_rate_limit
-- Resets rate limit status for a key after successful call
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_key_rate_limit(
  p_key_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE api_keys
  SET 
    consecutive_429_count = 0,
    updated_at = now()
  WHERE id = p_key_id
    AND consecutive_429_count > 0;
END;
$$;

-- ============================================================================
-- FUNCTION: cleanup_old_key_locks
-- Removes old lock records (older than 24 hours)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_old_key_locks() 
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM api_key_locks
  WHERE released_at IS NOT NULL
    AND released_at < now() - interval '24 hours';
  
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Enable RLS on api_key_locks (admin only via service role)
ALTER TABLE public.api_key_locks ENABLE ROW LEVEL SECURITY;

-- No public policies - only service role can access
-- (Supabase service role bypasses RLS)