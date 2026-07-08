ALTER TABLE vm_templates
  ADD COLUMN IF NOT EXISTS pool_target_ready_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vm_templates
  DROP CONSTRAINT IF EXISTS vm_templates_pool_target_ready_count_check;

ALTER TABLE vm_templates
  ADD CONSTRAINT vm_templates_pool_target_ready_count_check
  CHECK (pool_target_ready_count >= 0 AND pool_target_ready_count <= 500);

CREATE TABLE IF NOT EXISTS vm_pool_instances (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES vm_templates(id) ON DELETE CASCADE,
  proxmox_template_vmid INTEGER NOT NULL,
  proxmox_vmid INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  node TEXT,
  pool_name TEXT NOT NULL DEFAULT 'pool',
  pool_ip_address TEXT,
  status TEXT NOT NULL DEFAULT 'preparing',
  reserved_by_deployment_id UUID REFERENCES lab_deployments(id) ON DELETE SET NULL,
  reserved_for_vm_id TEXT,
  reserved_run_id TEXT,
  consumed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vm_pool_instances_status_check
    CHECK (status IN ('preparing', 'ready', 'reserved', 'consumed', 'failed', 'deleting'))
);

CREATE INDEX IF NOT EXISTS idx_vm_pool_instances_template_status
  ON vm_pool_instances(template_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_vm_pool_instances_deployment
  ON vm_pool_instances(reserved_by_deployment_id);

CREATE TABLE IF NOT EXISTS deployment_vm_allocations (
  deployment_id UUID NOT NULL REFERENCES lab_deployments(id) ON DELETE CASCADE,
  logical_vm_id TEXT NOT NULL,
  planned_vmid INTEGER NOT NULL,
  actual_vmid INTEGER NOT NULL,
  template_id UUID NOT NULL REFERENCES vm_templates(id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  pool_instance_id UUID REFERENCES vm_pool_instances(id) ON DELETE SET NULL,
  run_id TEXT,
  name TEXT,
  ip_address TEXT,
  node TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deployment_id, logical_vm_id),
  CONSTRAINT deployment_vm_allocations_source_check
    CHECK (source IN ('terraform', 'pool')),
  CONSTRAINT deployment_vm_allocations_status_check
    CHECK (status IN ('active', 'replaced', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_deployment_vm_allocations_actual_vmid
  ON deployment_vm_allocations(actual_vmid);

CREATE INDEX IF NOT EXISTS idx_deployment_vm_allocations_pool_instance
  ON deployment_vm_allocations(pool_instance_id);
