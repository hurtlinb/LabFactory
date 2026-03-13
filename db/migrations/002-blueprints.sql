CREATE TABLE IF NOT EXISTS vm_templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  proxmox_template_vmid INTEGER NOT NULL,
  full_clone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lab_blueprints (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lab_blueprint_vms (
  id UUID PRIMARY KEY,
  blueprint_id UUID NOT NULL REFERENCES lab_blueprints(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES vm_templates(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  vm_order INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_blueprint_vms_blueprint_id
  ON lab_blueprint_vms(blueprint_id, vm_order);

INSERT INTO vm_templates
  (id, name, description, proxmox_template_vmid, full_clone, created_at, updated_at)
VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    'VM Windows 2022',
    'Windows Server 2022 base image ready for Active Directory or IIS labs.',
    9001,
    TRUE,
    NOW(),
    NOW()
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'VM Ubuntu 24.04',
    'Ubuntu 24.04 LTS template for Linux and container workloads.',
    9002,
    FALSE,
    NOW(),
    NOW()
  )
ON CONFLICT (id) DO NOTHING;
