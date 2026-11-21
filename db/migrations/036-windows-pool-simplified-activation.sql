-- Windows pool: simplified activation (user decision 2026-11-21).
--  * no more qualification: a template is enabled/disabled from the VM Models page;
--  * the ceiling is global (all templates together), no longer per template;
--  * the ready reserve of a template is no longer bounded by its own ceiling.
-- Idempotent (the migration runner may replay every file).
ALTER TABLE windows_pool_templates DROP CONSTRAINT IF EXISTS windows_pool_templates_enabled_qualified;
ALTER TABLE windows_pool_templates DROP CONSTRAINT IF EXISTS windows_pool_templates_target_le_capacity;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'windows_pool_settings' AND column_name = 'max_capacity') THEN
    ALTER TABLE windows_pool_settings ADD COLUMN max_capacity INTEGER NOT NULL DEFAULT 50
      CHECK (max_capacity >= 1 AND max_capacity <= 2000);
    -- First application only: the largest per-template ceiling configured so far.
    UPDATE windows_pool_settings
       SET max_capacity = GREATEST(1, LEAST(2000, COALESCE((SELECT MAX(max_capacity) FROM windows_pool_templates), 50)));
  END IF;
END $$;
