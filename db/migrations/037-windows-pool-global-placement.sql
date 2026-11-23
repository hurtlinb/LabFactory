-- Windows pool: node, storage and parallel preparations become GLOBAL settings, common to every
-- template (user decision 2026-11-23). The per-template columns stay but are no longer read.
--  * node: NULL = automatic placement;
--  * storage: storage of the linked clones (VMID checks, placement);
--  * max_parallel_preparations: VMs in creation/preparation, all templates together.
-- Idempotent (the migration runner may replay every file).
ALTER TABLE windows_pool_templates DROP CONSTRAINT IF EXISTS windows_pool_templates_enabled_placement;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'windows_pool_settings' AND column_name = 'max_parallel_preparations') THEN
    ALTER TABLE windows_pool_settings
      ADD COLUMN node TEXT CHECK (node IS NULL OR node ~ '^[A-Za-z0-9._-]{1,64}$'),
      ADD COLUMN storage TEXT CHECK (storage IS NULL OR storage ~ '^[A-Za-z0-9._-]{1,64}$'),
      ADD COLUMN max_parallel_preparations INTEGER NOT NULL DEFAULT 4 CHECK (max_parallel_preparations BETWEEN 1 AND 64);
    -- First application only: values of the templates configured so far (most used storage,
    -- largest parallelism); the node stays automatic.
    UPDATE windows_pool_settings SET
      storage = (SELECT storage FROM windows_pool_templates WHERE storage IS NOT NULL
                  GROUP BY storage ORDER BY COUNT(*) DESC, storage LIMIT 1),
      max_parallel_preparations = GREATEST(1, LEAST(64, COALESCE((SELECT MAX(max_parallel_preparations) FROM windows_pool_templates), 4)));
  END IF;
END $$;
