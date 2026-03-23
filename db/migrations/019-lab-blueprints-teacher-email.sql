ALTER TABLE lab_blueprints
  ADD COLUMN IF NOT EXISTS teacher_email TEXT;

UPDATE lab_blueprints
   SET teacher_email = COALESCE(NULLIF(TRIM(teacher_email), ''), 'unknown@local')
 WHERE teacher_email IS NULL OR TRIM(teacher_email) = '';

ALTER TABLE lab_blueprints
  ALTER COLUMN teacher_email SET NOT NULL;

INSERT INTO teachers (email, created_at, updated_at)
SELECT DISTINCT b.teacher_email, NOW(), NOW()
  FROM lab_blueprints b
 WHERE b.teacher_email IS NOT NULL
   AND TRIM(b.teacher_email) <> ''
ON CONFLICT (email) DO NOTHING;
