-- Reset another failed job to test
UPDATE speaking_evaluation_jobs 
SET status = 'pending', 
    stage = 'pending_eval', 
    retry_count = 0, 
    last_error = NULL, 
    lock_token = NULL, 
    lock_expires_at = NULL,
    updated_at = now()
WHERE id = 'd21aa8d1-82e9-4006-9942-bd08bb7d82c2';