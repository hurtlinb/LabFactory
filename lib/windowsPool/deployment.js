import { createPoolRequest, cancelPoolRequest } from './reservation.js';
import { cancelPoolRequestVerified } from './cancellation.js';
import { computeWindowsDemand, isWindowsOsType } from './config.js';

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
export async function classifyDeploymentVms(db, { deploymentId, vms, replaceVmids = [] }) {
  const windowsTemplateIds = [...new Set(vms.filter(vm => isWindowsOsType(vm.osType) && vm.templateId).map(vm => vm.templateId))];
  const enabled = new Set(windowsTemplateIds.length
    ? (await db.query('SELECT template_id FROM windows_pool_templates WHERE enabled AND template_id = ANY($1::uuid[])', [windowsTemplateIds])).rows.map(r => r.template_id)
    : []);
  const activePoolSlots = new Set((await db.query(
    `SELECT workstation_number, blueprint_vm_id FROM lab_vm_assignments
      WHERE deployment_id = $1 AND status = 'active' AND manager = 'windows-pool'`, [deploymentId]))
    .rows.map(r => `${r.workstation_number}|${r.blueprint_vm_id}`));
  const slotKey = vm => { const s = parseSlotId(vm.id); return `${s.workstationNumber}|${s.blueprintVmId}`; };

  if (replaceVmids.length) {
    const scoped = vms.filter(vm => replaceVmids.includes(Number(vm.vmid)));
    if (scoped.some(vm => activePoolSlots.has(slotKey(vm)))) {
      throw new PoolDeploymentError('POOL_REDEPLOY_UNSUPPORTED',
        'Redeploying a workstation served by the Windows pool is not supported yet (lot P5)');
    }
    // Redeploy of a historical lab: Terraform only, unchanged; the slots already served
    // by the pool (other workstations) stay out of the Terraform definitions.
    return { poolVms: [], terraformVms: vms.filter(vm => !activePoolSlots.has(slotKey(vm))) };
  }
  const poolVms = vms.filter(vm => isWindowsOsType(vm.osType) && vm.templateId && enabled.has(vm.templateId));
  for (const vm of poolVms) parseSlotId(vm.id); // reject an unexpected identifier before anything else
  const poolIds = new Set(poolVms.map(vm => vm.id));
  return { poolVms, terraformVms: vms.filter(vm => !poolIds.has(vm.id)) };
}

// Pool request of a run: reused if it already exists (resumed delayed job), otherwise
// created; a request left behind by another run is cancelled first (verified).
export async function ensureRunPoolRequest({ db, proxmox, deploymentId, runId, poolVms }) {
  const active = (await db.query(
    `SELECT * FROM windows_pool_requests WHERE deployment_id = $1 AND status IN ('waiting_for_pool', 'reserved')`,
    [deploymentId])).rows[0];
  if (active?.run_id === runId) return active;
  if (active) {
    if (active.status === 'reserved' && proxmox) await cancelPoolRequestVerified({ db, proxmox, requestId: active.id });
    else await cancelPoolRequest(db, active.id);
  }
  return createPoolRequest(db, { deploymentId, kind: 'deploy', demand: computeWindowsDemand(poolVms), runId });
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
  templateStorage, ipConfigFor, defaultPassword, adminUserFor }) {
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
        secondDisk: vm.secondDiskSizeGb ? { sizeGb: Number(vm.secondDiskSizeGb), storage: templateStorage(vm.templateId) } : null
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

// Payload of the pool VMs as seen by readiness/customization: real VMID and IP.
export function applyAssignmentsToPayload(vms, assigned) {
  const bySlot = new Map(assigned.map(item => [item.payloadVm.id, item]));
  return vms.map(vm => {
    const item = bySlot.get(vm.id);
    return item ? { ...vm, vmid: item.vmid, poolAssigned: true, assignedIpAddress: item.ipAddress } : vm;
  });
}
