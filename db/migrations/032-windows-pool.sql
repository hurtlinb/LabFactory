-- Windows VM pool (redesign, see WINDOWS_POOL_IMPLEMENTATION.md, lot P1).
-- New schema: the historical pool (migrations 025-028, removed by 029) is not reused.
-- Idempotent: src/infrastructure/db/runMigrations.ts replays every file on start.
-- Creates no Proxmox VMs. Every template stays disabled until explicitly configured.

-- Global settings (single row).
CREATE TABLE IF NOT EXISTS windows_pool_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  cluster TEXT NOT NULL DEFAULT 'default',
  -- Dedicated range, kept apart from the Terraform VMIDs (10000 + n*10, up to about 60100).
  vmid_min INTEGER NOT NULL DEFAULT 70000,
  vmid_max INTEGER NOT NULL DEFAULT 79999,
  -- Controlled suspension: no new assignment and no direct-clone fallback.
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  -- Proxmox resource pool of the pool VMs (e.g. labs-dev); NULL = no resource pool.
  proxmox_pool TEXT CHECK (proxmox_pool IS NULL OR proxmox_pool ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- DNS applied to Windows VMs on lab assignment (user decision 2026-11-20).
  dns_servers TEXT[] NOT NULL DEFAULT ARRAY['195.186.4.162', '195.186.4.163']
    CHECK (cardinality(dns_servers) BETWEEN 1 AND 4),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT windows_pool_settings_vmid_range CHECK (vmid_min >= 100 AND vmid_max <= 999999999 AND vmid_min <= vmid_max)
);
INSERT INTO windows_pool_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Per-template configuration. A new revision = a new Proxmox template (new VMID):
-- linked clones depend on the base disk of their template.
CREATE TABLE IF NOT EXISTS windows_pool_templates (
  template_id UUID PRIMARY KEY REFERENCES vm_templates(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ready_target INTEGER NOT NULL DEFAULT 0 CHECK (ready_target >= 0),
  max_capacity INTEGER NOT NULL DEFAULT 1 CHECK (max_capacity >= 1),
  max_parallel_preparations INTEGER NOT NULL DEFAULT 1 CHECK (max_parallel_preparations >= 1),
  node TEXT,
  storage TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_template_vmid INTEGER NOT NULL CHECK (source_template_vmid >= 100),
  clone_mode TEXT NOT NULL DEFAULT 'linked' CHECK (clone_mode = 'linked'),
  preparation_timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (preparation_timeout_seconds BETWEEN 300 AND 7200),
  assignment_timeout_seconds INTEGER NOT NULL DEFAULT 900 CHECK (assignment_timeout_seconds BETWEEN 60 AND 3600),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT windows_pool_templates_target_le_capacity CHECK (ready_target <= max_capacity),
  CONSTRAINT windows_pool_templates_enabled_placement CHECK (NOT enabled OR (node IS NOT NULL AND storage IS NOT NULL))
);

-- Requests (demand of a deploy or redeploy). Atomic reservation of the whole demand.
CREATE TABLE IF NOT EXISTS windows_pool_requests (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL REFERENCES lab_deployments(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('deploy', 'redeploy-workstation')),
  -- Job run (lab_deployments.last_run_id) that created the request: a request left
  -- behind by an abandoned run is cancelled (verified) before a new run.
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'waiting_for_pool'
    CHECK (status IN ('waiting_for_pool', 'reserved', 'fulfilled', 'cancelled', 'failed')),
  -- [{ "templateId": uuid, "count": n }] ; the revision is resolved at reservation time.
  demand JSONB NOT NULL CHECK (jsonb_typeof(demand) = 'array' AND jsonb_array_length(demand) > 0),
  blocked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reserved_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A single active request per lab (operations on a lab are already exclusive).
CREATE UNIQUE INDEX IF NOT EXISTS windows_pool_requests_one_active
  ON windows_pool_requests (deployment_id) WHERE status IN ('waiting_for_pool', 'reserved');
CREATE INDEX IF NOT EXISTS windows_pool_requests_waiting_fifo
  ON windows_pool_requests (created_at, id) WHERE status = 'waiting_for_pool';

-- Physical inventory of the VMs created by the pool.
CREATE TABLE IF NOT EXISTS windows_pool_vms (
  id UUID PRIMARY KEY, -- also the ownership identity written into Proxmox (labfactory-pool:<id>)
  template_id UUID NOT NULL REFERENCES windows_pool_templates(template_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  source_template_vmid INTEGER NOT NULL,
  cluster TEXT NOT NULL,
  node TEXT NOT NULL,
  vmid INTEGER NOT NULL CHECK (vmid >= 100),
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN (
    'creating', 'preparing', 'ready', 'reserved', 'configuring', 'assigned',
    'deleting', 'deleted', 'quarantined')),
  version INTEGER NOT NULL DEFAULT 0,
  request_id UUID REFERENCES windows_pool_requests(id) ON DELETE RESTRICT,
  mac TEXT,
  current_task_upid TEXT,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  reserved_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT windows_pool_vms_request_when_reserved
    CHECK (state NOT IN ('reserved', 'configuring', 'assigned') OR request_id IS NOT NULL)
);
-- A VMID can belong to at most one living pool VM (Proxmox reuses IDs after deletion).
CREATE UNIQUE INDEX IF NOT EXISTS windows_pool_vms_live_vmid
  ON windows_pool_vms (cluster, vmid) WHERE state <> 'deleted';
CREATE INDEX IF NOT EXISTS windows_pool_vms_ready_fifo
  ON windows_pool_vms (template_id, revision, ready_at, id) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS windows_pool_vms_by_state ON windows_pool_vms (template_id, state);

-- State-transition log (audit, per-VM timeline, P6 measurements).
CREATE TABLE IF NOT EXISTS windows_pool_vm_events (
  id BIGSERIAL PRIMARY KEY,
  pool_vm_id UUID NOT NULL REFERENCES windows_pool_vms(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS windows_pool_vm_events_vm ON windows_pool_vm_events (pool_vm_id, id);

-- Logical slot (deployment, workstation, blueprint VM) -> physical VM and its manager.
-- Covers Windows from the pool and the VMs kept under Terraform, to have a single source of truth.
CREATE TABLE IF NOT EXISTS lab_vm_assignments (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL REFERENCES lab_deployments(id) ON DELETE RESTRICT,
  workstation_number INTEGER NOT NULL CHECK (workstation_number >= 1),
  blueprint_vm_id UUID NOT NULL,
  manager TEXT NOT NULL CHECK (manager IN ('windows-pool', 'terraform')),
  cluster TEXT NOT NULL,
  node TEXT,
  vmid INTEGER NOT NULL CHECK (vmid >= 100),
  pool_vm_id UUID REFERENCES windows_pool_vms(id) ON DELETE RESTRICT,
  request_id UUID REFERENCES windows_pool_requests(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'released')),
  replaces_assignment_id UUID REFERENCES lab_vm_assignments(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT lab_vm_assignments_pool_vm_matches_manager
    CHECK ((manager = 'windows-pool') = (pool_vm_id IS NOT NULL)),
  CONSTRAINT lab_vm_assignments_ended
    CHECK ((status = 'active') = (ended_at IS NULL))
);
-- Exactly one active assignment per logical slot.
CREATE UNIQUE INDEX IF NOT EXISTS lab_vm_assignments_active_slot
  ON lab_vm_assignments (deployment_id, workstation_number, blueprint_vm_id) WHERE status = 'active';
-- A pool VM is assigned at most once in its lifetime (never returned to the clean stock).
CREATE UNIQUE INDEX IF NOT EXISTS lab_vm_assignments_pool_vm_once
  ON lab_vm_assignments (pool_vm_id) WHERE pool_vm_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lab_vm_assignments_active_vmid
  ON lab_vm_assignments (cluster, vmid) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS lab_vm_assignments_deployment ON lab_vm_assignments (deployment_id, status);

-- Distributed limits: shared by every worker and replica.
-- scope: 'cluster', 'node:<name>' or 'storage:<name>'. max_active = 0 suspends the category.
CREATE TABLE IF NOT EXISTS windows_pool_operation_limits (
  category TEXT NOT NULL CHECK (category IN (
    'clone', 'prepare', 'guest_probe', 'assign', 'customize', 'lifecycle', 'destroy')),
  scope TEXT NOT NULL CHECK (scope = 'cluster' OR scope ~ '^(node|storage):[A-Za-z0-9._-]+$'),
  max_active INTEGER NOT NULL CHECK (max_active >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, scope)
);
-- Conservative defaults pending measurement (P0: 2 parallel preparations without degradation).
INSERT INTO windows_pool_operation_limits (category, scope, max_active) VALUES
  ('clone', 'cluster', 2),
  ('prepare', 'cluster', 4),
  ('guest_probe', 'cluster', 8),
  ('assign', 'cluster', 4),
  ('customize', 'cluster', 5),
  ('lifecycle', 'cluster', 8),
  ('destroy', 'cluster', 4)
ON CONFLICT (category, scope) DO NOTHING;

-- Active leases. A lease tied to a Proxmox task (proxmox_upid) keeps counting
-- after it expires, until reconciliation: a task can outlive its worker.
CREATE TABLE IF NOT EXISTS windows_pool_operation_leases (
  id UUID PRIMARY KEY,
  category TEXT NOT NULL,
  scope TEXT NOT NULL,
  holder TEXT NOT NULL,
  pool_vm_id UUID REFERENCES windows_pool_vms(id) ON DELETE SET NULL,
  proxmox_upid TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (category, scope) REFERENCES windows_pool_operation_limits(category, scope) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS windows_pool_operation_leases_scope
  ON windows_pool_operation_leases (category, scope);
