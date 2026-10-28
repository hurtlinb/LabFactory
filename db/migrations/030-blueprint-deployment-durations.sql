CREATE TABLE IF NOT EXISTS blueprint_deployment_durations (
  run_id TEXT PRIMARY KEY,
  blueprint_id UUID NOT NULL REFERENCES lab_blueprints(id) ON DELETE CASCADE,
  deployment_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

-- No FK on deployment_id: measurements survive lab destruction.
CREATE INDEX IF NOT EXISTS blueprint_deployment_durations_completed
  ON blueprint_deployment_durations (blueprint_id) WHERE finished_at IS NOT NULL;
