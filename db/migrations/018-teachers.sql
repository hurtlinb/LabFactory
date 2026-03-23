CREATE TABLE IF NOT EXISTS teachers (
  email TEXT PRIMARY KEY,
  initials TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO teachers (email, created_at, updated_at)
SELECT DISTINCT d.teacher_email, NOW(), NOW()
  FROM lab_deployments d
 WHERE d.teacher_email IS NOT NULL
   AND TRIM(d.teacher_email) <> ''
ON CONFLICT (email) DO NOTHING;
