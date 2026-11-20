-- Windows pool: automatic placement (user decision 2026-11-20).
-- The node of a template becomes optional: empty = for each new VM, the online node that sees
-- the template storage and has the most free memory. The storage stays mandatory to enable it.
-- Idempotent.
ALTER TABLE windows_pool_templates DROP CONSTRAINT IF EXISTS windows_pool_templates_enabled_placement;
ALTER TABLE windows_pool_templates
  ADD CONSTRAINT windows_pool_templates_enabled_placement CHECK (NOT enabled OR storage IS NOT NULL);
