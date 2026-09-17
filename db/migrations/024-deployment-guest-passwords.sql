ALTER TABLE lab_blueprints
  ADD COLUMN IF NOT EXISTS guest_password_mode TEXT NOT NULL DEFAULT 'shared';

ALTER TABLE lab_deployments
  ADD COLUMN IF NOT EXISTS workstation_passwords JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE lab_blueprints
SET guest_password_mode = 'shared'
WHERE guest_password_mode IS NULL OR guest_password_mode NOT IN ('shared', 'per-workstation');

ALTER TABLE lab_blueprints
  DROP CONSTRAINT IF EXISTS lab_blueprints_guest_password_mode_check;

ALTER TABLE lab_blueprints
  ADD CONSTRAINT lab_blueprints_guest_password_mode_check
  CHECK (guest_password_mode IN ('shared', 'per-workstation'));
