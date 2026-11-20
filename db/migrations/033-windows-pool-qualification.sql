-- Windows pool (lot P6): mandatory qualification before activation.
-- A template can only be enabled if it has been qualified FOR ITS CURRENT REVISION
-- (a new revision = a new Proxmox template, to be qualified again).
-- Idempotent (src/infrastructure/db/runMigrations.ts replays every file).
ALTER TABLE windows_pool_templates
  ADD COLUMN IF NOT EXISTS qualified_revision INTEGER,
  ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qualified_by TEXT,
  ADD COLUMN IF NOT EXISTS qualification_note TEXT;

DO $$
BEGIN
  -- Scoped to THIS table (search_path): pg_constraint covers every schema, an existing
  -- constraint of the same name elsewhere must not prevent creating it here.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'windows_pool_templates_enabled_qualified'
                    AND conrelid = 'windows_pool_templates'::regclass) THEN
    ALTER TABLE windows_pool_templates
      ADD CONSTRAINT windows_pool_templates_enabled_qualified
      CHECK (NOT enabled OR (qualified_revision IS NOT NULL AND qualified_revision = revision));
  END IF;
END $$;
