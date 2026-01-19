-- Reset failed jobs to allow retry
UPDATE speaking_evaluation_jobs 
SET status = 'pending', 
    stage = 'pending_eval', 
    retry_count = 0, 
    last_error = NULL, 
    lock_token = NULL, 
    lock_expires_at = NULL,
    updated_at = now()
WHERE status = 'failed' 
  AND retry_count >= 5 
  AND file_paths IS NOT NULL
  AND id IN (SELECT id FROM speaking_evaluation_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1);