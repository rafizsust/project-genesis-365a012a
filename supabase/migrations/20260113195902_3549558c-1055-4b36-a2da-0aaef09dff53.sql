-- Rename flash quota columns to flash_2_5 to specifically track Gemini 2.5 Flash model
-- In api_keys table
ALTER TABLE public.api_keys RENAME COLUMN flash_quota_exhausted TO flash_2_5_quota_exhausted;
ALTER TABLE public.api_keys RENAME COLUMN flash_quota_exhausted_date TO flash_2_5_quota_exhausted_date;

-- In user_api_keys table
ALTER TABLE public.user_api_keys RENAME COLUMN flash_quota_exhausted TO flash_2_5_quota_exhausted;
ALTER TABLE public.user_api_keys RENAME COLUMN flash_quota_exhausted_date TO flash_2_5_quota_exhausted_date;