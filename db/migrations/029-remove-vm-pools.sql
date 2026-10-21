-- Remove the schema introduced by migrations 025-028 after the pool rollback.
-- IF EXISTS also supports installations that never enabled this feature.
-- Stop all workers running the pool implementation before applying this migration.
-- This does not delete Proxmox VMs or alter Terraform state / deployment records.
-- Keep schema_migrations entries as an audit trail of previously applied changes.

DROP TABLE IF EXISTS vm_pool;
DROP SEQUENCE IF EXISTS vm_pool_vmid_seq;

ALTER TABLE vm_templates
  DROP CONSTRAINT IF EXISTS enabled_pool_has_capacity,
  DROP COLUMN IF EXISTS pool_enabled,
  DROP COLUMN IF EXISTS pool_size;

ALTER TABLE lab_deployments
  DROP COLUMN IF EXISTS pool_assignments;
