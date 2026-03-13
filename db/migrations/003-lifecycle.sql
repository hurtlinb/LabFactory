CREATE TABLE IF NOT EXISTS lab_blueprint_lifecycle (
  blueprint_id UUID PRIMARY KEY REFERENCES lab_blueprints(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle',
  last_action TEXT,
  last_job_id TEXT,
  last_run_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
