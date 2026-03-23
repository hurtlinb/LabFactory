ALTER TABLE lab_deployments
  ADD COLUMN IF NOT EXISTS teacher_email TEXT;

UPDATE lab_deployments
   SET teacher_email = COALESCE(NULLIF(TRIM(teacher_email), ''), 'unknown@local')
 WHERE teacher_email IS NULL OR TRIM(teacher_email) = '';

ALTER TABLE lab_deployments
  ALTER COLUMN teacher_email SET NOT NULL;
