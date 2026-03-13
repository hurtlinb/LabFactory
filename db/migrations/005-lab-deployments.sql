CREATE TABLE IF NOT EXISTS lab_deployments (
  id UUID PRIMARY KEY,
  blueprint_id UUID NOT NULL REFERENCES lab_blueprints(id) ON DELETE CASCADE,
  classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle',
  last_action TEXT,
  last_job_id TEXT,
  last_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
