-- Create model performance analytics table
CREATE TABLE public.model_performance_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE CASCADE,
  model_name text NOT NULL,
  task_type text NOT NULL, -- 'generate', 'explain', 'evaluate_writing', 'evaluate_speaking', 'tts'
  status text NOT NULL, -- 'success', 'error', 'quota_exceeded'
  response_time_ms integer,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create index for performance queries
CREATE INDEX idx_model_performance_logs_created_at ON public.model_performance_logs(created_at DESC);
CREATE INDEX idx_model_performance_logs_model_name ON public.model_performance_logs(model_name);
CREATE INDEX idx_model_performance_logs_task_type ON public.model_performance_logs(task_type);

-- Enable RLS
ALTER TABLE public.model_performance_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can access
CREATE POLICY "Admins can manage model performance logs"
ON public.model_performance_logs
FOR ALL
USING (public.is_admin(auth.uid()));

-- Create function to log model performance
CREATE OR REPLACE FUNCTION public.log_model_performance(
  p_api_key_id uuid,
  p_model_name text,
  p_task_type text,
  p_status text,
  p_response_time_ms integer DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.model_performance_logs (
    api_key_id,
    model_name,
    task_type,
    status,
    response_time_ms,
    error_message
  ) VALUES (
    p_api_key_id,
    p_model_name,
    p_task_type,
    p_status,
    p_response_time_ms,
    p_error_message
  );
END;
$$;

-- Create function to get model performance stats
CREATE OR REPLACE FUNCTION public.get_model_performance_stats(p_hours integer DEFAULT 24)
RETURNS TABLE (
  model_name text,
  task_type text,
  total_calls bigint,
  success_count bigint,
  error_count bigint,
  quota_exceeded_count bigint,
  avg_response_time_ms numeric,
  success_rate numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    model_name,
    task_type,
    COUNT(*) as total_calls,
    COUNT(*) FILTER (WHERE status = 'success') as success_count,
    COUNT(*) FILTER (WHERE status = 'error') as error_count,
    COUNT(*) FILTER (WHERE status = 'quota_exceeded') as quota_exceeded_count,
    ROUND(AVG(response_time_ms) FILTER (WHERE status = 'success'), 0) as avg_response_time_ms,
    ROUND(
      (COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
      1
    ) as success_rate
  FROM public.model_performance_logs
  WHERE created_at > now() - (p_hours || ' hours')::interval
  GROUP BY model_name, task_type
  ORDER BY total_calls DESC;
$$;