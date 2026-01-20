-- Add missing model columns to speaking_evaluation_settings
ALTER TABLE public.speaking_evaluation_settings 
ADD COLUMN IF NOT EXISTS groq_stt_model TEXT DEFAULT 'whisper-large-v3-turbo',
ADD COLUMN IF NOT EXISTS groq_llm_model TEXT DEFAULT 'llama-3.3-70b-versatile',
ADD COLUMN IF NOT EXISTS gemini_model TEXT DEFAULT 'gemini-2.5-flash';