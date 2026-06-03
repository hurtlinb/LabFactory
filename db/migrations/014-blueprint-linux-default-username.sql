ALTER TABLE lab_blueprints
ADD COLUMN IF NOT EXISTS linux_default_username TEXT NOT NULL DEFAULT 'ubuntu';

UPDATE lab_blueprints
SET linux_default_username = 'ubuntu'
WHERE COALESCE(BTRIM(linux_default_username), '') = '';
