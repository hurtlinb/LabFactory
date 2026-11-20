import { createPoolRequest, cancelPoolRequest } from './reservation.js';
import { cancelPoolRequestVerified } from './cancellation.js';
import { computeWindowsDemand, isWindowsOsType } from './config.js';
import { ownershipMarker } from './vmidAllocator.js';

// Wiring of the Windows pool into the deploy flow (lot P4b). Pure functions or
// DB functions only: the Terraform worker calls them, no Proxmox call here except the
// verified cancellation of an abandoned request.
//
// Transition rule (user decision 2026-11-20): a Windows VM goes through the pool
// if and only if its template is enabled in the pool. Otherwise the historical
// (Terraform) flow is unchanged. Scope of P4b: FULL deploy of a lab. Redeploying a
// workstation served by the pool requires the replace sequence (P5): refused explicitly.

export class PoolDeploymentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Payload slot identifier: "<NN>-<blueprintVmId>" (dashboard/server.js buildTerraformDeploymentPayload).
export function parseSlotId(id) {
  const match = /^(\d{2,})-([0-9a-f-]{36})$/i.exec(String(id ?? ''));
  if (!match) throw new PoolDeploymentError('SLOT_ID_INVALID', `Unexpected VM identifier: ${id}`);
  return { workstationNumber: Number(match[1]), blueprintVmId: match[2] };
}

// Splits the payload VMs into pool VMs and Terraform VMs.
// Full deploy: Windows of an enabled template -> pool. Redeploy of workstations (replaceVmids):
//  - slot already served by the pool -> new pool VM (even if the template is now disabled:
//    no fallback, the request waits), the old one is replaced (replacements);
//  - historical Windows (Terraform) whose template is now enabled -> pool VM, the old one is
//    destroyed by Terraform (retiredTerraformVmids) after being disconnected;
//  - the rest -> Terraform replace, unchanged.
// terraformTargetVmids: VMIDs targeted by Terraform in redeploy (empty => no Terraform at all:
// a plan without -target would touch the whole lab).
export async function classifyDeploymentVms(db, { deploymentId, vms, replaceVmids = [] }) {
  const windowsTemplateIds = [...new Set(vms.filter(vm => isWindowsOsType(vm.osType) && vm.templateId).map(vm => vm.templateId))];
  const enabled = new Set(windowsTemplateIds.length
    ? (await db.query('SELECT template_id FROM windows_pool_templates WHERE enabled AND template_id = ANY($1::uuid[])', [windowsTemplateIds])).rows.map(r => r.template_id)
    : []);
  const activePoolAssignments = new Map((await db.query(
    `SELECT * FROM lab_vm_assignments
      WHERE deployment_id = $1 AND status = 'active' AND manager = 'windows-pool'`, [deploymentId]))
    .rows.map(r => [`${r.workstation_number}|${r.blueprint_vm_id}`, r]));
  const slotKey = vm => { const s = parseSlotId(vm.id); return `${s.workstationNumber}|${s.blueprintVmId}`; };
  const isPoolSlot = vm => { try { return activePoolAssignments.has(slotKey(vm)); } catch { return false; } };

  if (replaceVmids.length) {
    const scoped = vms.filter(vm => replaceVmids.includes(Number(vm.vmid)));
    const replacements = new Map(); // payload vm.id -> { assignment } | { legacyVmid }
    const poolVms = [];
    const retiredTerraformVmids = [];
    for (const vm of scoped) {
      if (isPoolSlot(vm)) {
        poolVms.push(vm);
        replacements.set(vm.id, { assignment: activePoolAssignments.get(slotKey(vm)) });
      } else if (isWindowsOsType(vm.osType) && vm.templateId && enabled.has(vm.templateId)) {
        parseSlotId(vm.id);
        poolVms.push(vm);
        replacements.set(vm.id, { legacyVmid: Number(vm.vmid) });
        retiredTerraformVmids.push(Number(vm.vmid));
      }
    }
    const poolIds = new Set(poolVms.map(vm => vm.id));
    // Terraform definitions: neither the slots served by the pool (other workstations included) nor
    // the historical Windows switching to the pool (absent from the config + targeted = destroyed).
    const terraformVms = vms.filter(vm => !isPoolSlot(vm) && !poolIds.has(vm.id));
    const terraformTargetVmids = [
      ...scoped.filter(vm => !poolIds.has(vm.id) && !isPoolSlot(vm)).map(vm => Number(vm.vmid)),
      ...retiredTerraformVmids
    ];
    return { poolVms, terraformVms, replacements, retiredTerraformVmids, terraformTargetVmids, kind: 'redeploy-workstation' };
  }
  const poolVms = vms.filter(vm => isWindowsOsType(vm.osType) && vm.templateId && enabled.has(vm.templateId));
  for (const vm of poolVms) parseSlotId(vm.id); // reject an unexpected identifier before anything else
  const poolIds = new Set(poolVms.map(vm => vm.id));
  return { poolVms, terraformVms: vms.filter(vm => !poolIds.has(vm.id)), replacements: new Map(), retiredTerraformVmids: [], terraformTargetVmids: null, kind: 'deploy' };
}

// Pool request of a run: reused if it already exists (resumed delayed job), otherwise
// created; a request left behind by another run is cancelled first (verified).
export async function ensureRunPoolRequest({ db, proxmox, deploymentId, runId, poolVms, kind = 'deploy' }) {
  const active = (await db.query(
    `SELECT * FROM windows_pool_requests WHERE deployment_id = $1 AND status IN ('waiting_for_pool', 'reserved')`,
    [deploymentId])).rows[0];
  if (active?.run_id === runId) return active;
  if (active) {
    if (active.status === 'reserved' && proxmox) await cancelPoolRequestVerified({ db, proxmox, requestId: active.id });
    else await cancelPoolRequest(db, active.id);
  }
  return createPoolRequest(db, { deploymentId, kind, demand: computeWindowsDemand(poolVms), runId });
}

// Redeploy: once the replacements are reserved, the OLD VMs of the slots are disconnected and
// stopped (their IP is freed before the new VM connects). A pool VM is only touched if it
// carries the marker of its pool slot. Returns the list of the retired VMIDs.
export async function retireReplacedVms({ db, proxmox, replacements, waitTimeoutMs = 5 * 60_000 }) {
  const retired = [];
  await Promise.all([...replacements.values()].map(async replacement => {
    const vmid = Number(replacement.assignment?.vmid ?? replacement.legacyVmid);
    const guest = await proxmox.findGuest(vmid);
    if (!guest) return;
    const config = await proxmox.getConfig(guest.node, vmid);
    if (replacement.assignment && !String(config.description ?? '').includes(ownershipMarker(replacement.assignment.pool_vm_id))) {
      throw new PoolDeploymentError('OWNERSHIP_LOST', `VM ${vmid} no longer carries the marker of its pool slot: replacement refused`);
    }
    const patch = { digest: config.digest };
    for (const key of Object.keys(config).filter(k => /^net\d+$/.test(k))) {
      patch[key] = `${String(config[key]).replace(/,link_down=\d/g, '')},link_down=1`;
    }
    await proxmox.setConfig(guest.node, vmid, patch);
    if ((await proxmox.status(guest.node, vmid))?.status === 'running') {
      const upid = await proxmox.request(`${proxmox.vmPath(guest.node, vmid)}/status/stop`, { method: 'POST' });
      await proxmox.waitTask(upid, { timeoutMs: waitTimeoutMs });
    }
    retired.push(vmid);
  }));
  if (db && retired.length) {
    // Trace in the journal of the retired pool VMs (they stay 'assigned' until the commit of their replacement).
    await db.query(
      `INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
       SELECT a.pool_vm_id, 'assigned', 'assigned', jsonb_build_object('code', 'RETIRED_FOR_REPLACEMENT')
         FROM lab_vm_assignments a WHERE a.id = ANY($1::uuid[])`,
      [[...replacements.values()].map(r => r.assignment?.id).filter(Boolean)]);
  }
  return retired;
}

// "ip=a.b.c.d/NN,gw=x.x.x.x" (buildCloudInitIpConfig, single source of the network rules) or "ip=dhcp".
export function networkFromIpConfig(ipconfig) {
  if (String(ipconfig).trim() === 'ip=dhcp') return { mode: 'dhcp' };
  const match = /^ip=(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2}),gw=(\d{1,3}(?:\.\d{1,3}){3})$/.exec(String(ipconfig).trim());
  if (!match) throw new PoolDeploymentError('NETWORK_INVALID', `Unexpected network configuration: ${ipconfig}`);
  return { mode: 'static', ipAddress: match[1], prefixLength: Number(match[2]), gateway: match[3] };
}

// Builds the assignment slots and matches each one to a reserved VM of the right template
// (deterministic order: workstation, then slot id; VMs by VMID).
export function buildAssignmentSlots({ poolVms, reservedVms, requestId, deploymentId, deploymentNumber, dnsServers,
  templateStorage, ipConfigFor, defaultPassword, adminUserFor, replacements = new Map() }) {
  const byTemplate = new Map();
  for (const vm of [...reservedVms].sort((a, b) => a.vmid - b.vmid)) {
    if (!byTemplate.has(vm.template_id)) byTemplate.set(vm.template_id, []);
    byTemplate.get(vm.template_id).push(vm);
  }
  const ordered = [...poolVms].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return ordered.map(vm => {
    const poolVm = byTemplate.get(vm.templateId)?.shift();
    if (!poolVm) throw new PoolDeploymentError('RESERVATION_MISMATCH', `No reserved VM for ${vm.name}`);
    const { workstationNumber, blueprintVmId } = parseSlotId(vm.id);
    const tags = String(vm.tags ?? '').split(';').map(tag => tag.trim()).filter(Boolean);
    if (deploymentNumber != null) tags.push(String(deploymentNumber));
    const vlanTag = Number(vm.vlanTag) > 0 ? Number(vm.vlanTag) : null;
    const password = String(vm.windowsAdminPassword ?? '').trim() || defaultPassword;
    if (!password) throw new PoolDeploymentError('PASSWORD_MISSING', `No Windows password for ${vm.name}: set it on the blueprint`);
    return {
      payloadVm: vm,
      poolVmId: poolVm.id,
      vmid: poolVm.vmid,
      slot: {
        requestId, deploymentId, workstationNumber, blueprintVmId,
        name: vm.name, tags, vlanTag,
        network: networkFromIpConfig(ipConfigFor(vm)),
        dnsServers,
        adminUser: String(vm.windowsAdminUsername ?? '').trim() || adminUserFor(vm.language),
        password,
        secondDisk: vm.secondDiskSizeGb ? { sizeGb: Number(vm.secondDiskSizeGb), storage: templateStorage(vm.templateId) } : null,
        // Redeploy: assignment replaced (closed and its VM destroyed at the commit of the new one).
        replacesAssignmentId: replacements.get(vm.id)?.assignment?.id ?? null
      }
    };
  });
}

// Runs every assignment in parallel (the 'assign' leases bound the real concurrency).
// Never throws: returns successes and failures per slot.
export async function runPoolAssignments({ assigner, plan, signal }) {
  const results = await Promise.allSettled(plan.map(item => assigner.assign(item.poolVmId, item.slot, { signal })));
  const assigned = [];
  const failed = [];
  results.forEach((result, index) => {
    const item = plan[index];
    if (result.status === 'fulfilled') assigned.push({ ...item, vmid: result.value.vmid, ipAddress: result.value.ipAddress ?? item.slot.network.ipAddress ?? null });
    else failed.push({ ...item, error: result.reason });
  });
  return { assigned, failed };
}

// Closes the request at the end of the run: fulfilled if every slot is assigned.
export async function finishRunPoolRequest(db, requestId, { allAssigned }) {
  await db.query(
    `UPDATE windows_pool_requests SET status = $2, finished_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'reserved'`, [requestId, allAssigned ? 'fulfilled' : 'failed']);
}

// --- Life cycle (lot P5) ------------------------------------------------------------------

// Active assignments of a lab. If the pool tables do not exist yet (migration 032 not
// applied): no assignment, the computed plan stays valid (historical labs).
export async function fetchActiveAssignments(db, deploymentId) {
  try {
    return (await db.query(
      `SELECT a.*, v.state AS pool_state FROM lab_vm_assignments a
         LEFT JOIN windows_pool_vms v ON v.id = a.pool_vm_id
        WHERE a.deployment_id = $1 AND a.status = 'active'`, [deploymentId])).rows;
  } catch (error) {
    if (error?.code === '42P01') return [];
    throw error;
  }
}

// Effective plan of a lab: the computed plan (buildTerraformDeploymentPayload) where every slot
// served by the pool carries its REAL VMID, its manager and its pool VM. Single source for
// status, start/stop, snapshots, reset IP/password, owner, redeploy and destroy.
export function overlayAssignments(vms, assignments) {
  const bySlot = new Map(assignments
    .filter(a => a.manager === 'windows-pool' && a.status === 'active')
    .map(a => [`${a.workstation_number}|${a.blueprint_vm_id}`, a]));
  if (!bySlot.size) return vms;
  return vms.map(vm => {
    let slot;
    try { slot = parseSlotId(vm.id); } catch { return vm; }
    const assignment = bySlot.get(`${slot.workstationNumber}|${slot.blueprintVmId}`);
    if (!assignment) return vm;
    return { ...vm, vmid: Number(assignment.vmid), manager: 'windows-pool', poolVmId: assignment.pool_vm_id, assignmentId: assignment.id, poolNode: assignment.node };
  });
}

// Destruction of the pool share of a lab. The lab is deleted only once every manager
// (Terraform AND pool) has succeeded: on failure (timeout), the error is raised and the lab
// keeps its information (requests, assignments, VMs) for a later attempt.
//  1. open requests cancelled (reserved VMs re-verified intact -> back to the stock);
//  2. active assignments closed ('released'); every remaining VM of the lab -> 'deleting'
//     (the manager destroys it after checking its ownership marker);
//  3. wait for 'deleted';
//  4. purge of the lab's pool rows (otherwise the RESTRICT FKs block its deletion).
export async function teardownDeploymentPool({ db, proxmox, deploymentId, timeoutMs = 20 * 60_000, pollMs = 5_000, sleepFn, log = console }) {
  const wait = sleepFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let requests;
  try {
    requests = (await db.query('SELECT id, status FROM windows_pool_requests WHERE deployment_id = $1', [deploymentId])).rows;
  } catch (error) {
    if (error?.code === '42P01') return { vms: 0 };
    throw error;
  }
  if (!requests.length) return { vms: 0 };
  for (const request of requests.filter(r => ['waiting_for_pool', 'reserved'].includes(r.status))) {
    if (request.status === 'reserved' && proxmox) await cancelPoolRequestVerified({ db, proxmox, requestId: request.id });
    else await cancelPoolRequest(db, request.id);
  }
  const requestIds = requests.map(r => r.id);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE lab_vm_assignments SET status = 'released', ended_at = NOW()
        WHERE deployment_id = $1 AND status = 'active' AND manager = 'windows-pool'`, [deploymentId]);
    await client.query(
      `WITH current AS (
         SELECT id, state FROM windows_pool_vms
          WHERE request_id = ANY($1::uuid[]) AND state IN ('reserved', 'configuring', 'assigned', 'quarantined')
          FOR UPDATE),
       updated AS (
         UPDATE windows_pool_vms v SET state = 'deleting', version = v.version + 1, state_changed_at = NOW()
           FROM current c WHERE v.id = c.id RETURNING v.id, c.state AS from_state)
       INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
       SELECT id, from_state, 'deleting', jsonb_build_object('code', 'LAB_DESTROYED', 'deploymentId', $2::text) FROM updated`,
      [requestIds, deploymentId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = (await db.query(
      `SELECT vmid, state FROM windows_pool_vms WHERE request_id = ANY($1::uuid[]) AND state <> 'deleted'`, [requestIds])).rows;
    if (!remaining.length) break;
    if (Date.now() > deadline) {
      throw new PoolDeploymentError('POOL_TEARDOWN_TIMEOUT',
        `Windows pool VMs not destroyed in time: ${remaining.map(r => `${r.vmid} (${r.state})`).join(', ')}; is the pool worker running?`);
    }
    await wait(pollMs);
  }
  const vms = (await db.query('SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE request_id = ANY($1::uuid[])', [requestIds])).rows[0].n;
  await db.query('UPDATE windows_pool_vms SET request_id = NULL WHERE request_id = ANY($1::uuid[]) AND state = \'deleted\'', [requestIds]);
  await db.query('DELETE FROM lab_vm_assignments WHERE deployment_id = $1', [deploymentId]);
  await db.query('DELETE FROM windows_pool_requests WHERE deployment_id = $1', [deploymentId]);
  log.info?.(`[windows-pool] lab ${deploymentId}: ${vms} pool VM(s) destroyed`);
  return { vms };
}

// Removal of the pool rows of a lab WITHOUT any living VM (deletion of a lab record already
// destroyed/failed). Refuses if a pool VM of the lab is still living.
export async function purgeDeploymentPoolRecords(db, deploymentId) {
  try {
    const living = (await db.query(
      `SELECT v.vmid, v.state FROM windows_pool_vms v JOIN windows_pool_requests r ON r.id = v.request_id
        WHERE r.deployment_id = $1 AND v.state NOT IN ('deleted')`, [deploymentId])).rows;
    if (living.length) {
      throw new PoolDeploymentError('POOL_VMS_LIVING', `Windows pool VMs still present (${living.map(r => r.vmid).join(', ')}): destroy the lab first`);
    }
    await db.query(`UPDATE windows_pool_vms SET request_id = NULL WHERE request_id IN (SELECT id FROM windows_pool_requests WHERE deployment_id = $1)`, [deploymentId]);
    await db.query('DELETE FROM lab_vm_assignments WHERE deployment_id = $1', [deploymentId]);
    await db.query('DELETE FROM windows_pool_requests WHERE deployment_id = $1', [deploymentId]);
  } catch (error) {
    if (error?.code === '42P01') return;
    throw error;
  }
}

// VMs managed by Terraform (historical and Linux): the others never enter its definitions.
export const terraformManagedVms = vms => vms.filter(vm => vm.manager !== 'windows-pool');

// Payload of the pool VMs as seen by readiness/customization: real VMID and IP.
export function applyAssignmentsToPayload(vms, assigned) {
  const bySlot = new Map(assigned.map(item => [item.payloadVm.id, item]));
  return vms.map(vm => {
    const item = bySlot.get(vm.id);
    return item ? { ...vm, vmid: item.vmid, poolAssigned: true, assignedIpAddress: item.ipAddress } : vm;
  });
}
