-- Update reset_api_key_quotas function to use new column names
CREATE OR REPLACE FUNCTION public.reset_api_key_quotas()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.api_keys
  SET 
    tts_quota_exhausted = false,
    tts_quota_exhausted_date = NULL
  WHERE tts_quota_exhausted = true 
    AND tts_quota_exhausted_date < CURRENT_DATE;
    
  UPDATE public.api_keys
  SET 
    flash_2_5_quota_exhausted = false,
    flash_2_5_quota_exhausted_date = NULL
  WHERE flash_2_5_quota_exhausted = true 
    AND flash_2_5_quota_exhausted_date < CURRENT_DATE;
END;
$function$;

-- Update reset_user_api_key_quotas function to use new column names
CREATE OR REPLACE FUNCTION public.reset_user_api_key_quotas()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  today TEXT := to_char(CURRENT_DATE, 'YYYY-MM-DD');
BEGIN
  -- Reset quotas where the exhausted date is before today
  UPDATE public.user_api_keys
  SET 
    tts_quota_exhausted = false,
    tts_quota_exhausted_date = NULL,
    flash_2_5_quota_exhausted = false,
    flash_2_5_quota_exhausted_date = NULL,
    updated_at = now()
  WHERE 
    (tts_quota_exhausted = true AND tts_quota_exhausted_date < today)
    OR (flash_2_5_quota_exhausted = true AND flash_2_5_quota_exhausted_date < today);
END;
$function$;