-- Lab usage tracking (Labs page):
--  * lab_deployments.last_used_at: last time the lab was deployed, started or stopped from
--    LabFactory, or seen with at least one running VM. NULL = unknown (labs older than this
--    migration that have not been used since).
--  * lab_usage_settings: single row (id = TRUE), edited from the Maintenance page. A running
--    lab is flagged as "probably forgotten" after forgotten_after_days days (it is also
--    flagged when it is still running outside class hours, a fixed rule in the dashboard).
-- Idempotent (the migration runner may replay every file).
ALTER TABLE lab_deployments ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS lab_usage_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  forgotten_after_days INTEGER NOT NULL DEFAULT 1 CHECK (forgotten_after_days BETWEEN 1 AND 30),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO lab_usage_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
