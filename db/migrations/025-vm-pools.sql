ALTER TABLE vm_templates
  ADD COLUMN pool_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN pool_size INTEGER NOT NULL DEFAULT 0 CHECK (pool_size BETWEEN 0 AND 1000),
  ADD CONSTRAINT enabled_pool_has_capacity CHECK (NOT pool_enabled OR pool_size > 0);

ALTER TABLE lab_deployments ADD COLUMN pool_assignments JSONB NOT NULL DEFAULT '{}';

CREATE SEQUENCE vm_pool_vmid_seq MINVALUE 900000 MAXVALUE 999999999 START 900000;
CREATE TABLE vm_pool (
  vmid INTEGER PRIMARY KEY DEFAULT nextval('vm_pool_vmid_seq'),
  ownership_token UUID NOT NULL DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES vm_templates(id) ON DELETE RESTRICT,
  source_vmid INTEGER NOT NULL,
  full_clone BOOLEAN NOT NULL,
  node TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'assigned', 'error')),
  deployment_id UUID REFERENCES lab_deployments(id) ON DELETE CASCADE,
  original_vmid INTEGER,
  task_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deployment_id, original_vmid)
);
CREATE INDEX vm_pool_available ON vm_pool(template_id, status);
