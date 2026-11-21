-- Windows pool: replacement of a VM that failed its assignment (user decision 2026-11-21).
-- { "<templateId>": n }: VMs a RESERVED request still needs to replace quarantined ones. The
-- manager counts it as demand (served even while labs are busy). Idempotent.
ALTER TABLE windows_pool_requests ADD COLUMN IF NOT EXISTS replacement_demand JSONB NOT NULL DEFAULT '{}'::jsonb;
