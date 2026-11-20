import { cancelPoolRequest } from './reservation.js';
import { ownershipMarker } from './vmidAllocator.js';
import { READINESS_PROBE_SCRIPT, evaluateReadiness, parseJsonOutput } from './qga.js';

// Cancellation of a pool request (lot P3). A reserved VM returns to the clean stock ONLY
// if it is proven intact, otherwise it is destroyed (state 'deleting', handled by the
// manager). "Intact" = every check below passes; at the slightest doubt -> destruction:
//  - Proxmox: VM present, ownership marker, no lock, running, every NIC link_down=1;
//  - QGA: full readiness verdict READY (bootstrap finished, NIC disconnected, marker
//    tied to this VM and to its revision).
// VMs already 'configuring' (network modified for the lab) are never verified: destroyed.

export async function verifyReservedVmIntact(proxmox, vm) {
  try {
    const guest = await proxmox.findGuest(vm.vmid);
    if (!guest) return { intact: false, reason: 'ABSENT' };
    const config = await proxmox.getConfig(guest.node, vm.vmid);
    if (!String(config?.description ?? '').includes(ownershipMarker(vm.id))) return { intact: false, reason: 'OWNERSHIP' };
    if (config.lock) return { intact: false, reason: `LOCK_${config.lock}` };
    const nets = Object.keys(config).filter(key => /^net\d+$/.test(key));
    if (!nets.length || !nets.every(key => /link_down=1/.test(config[key]))) return { intact: false, reason: 'NIC_CONNECTED' };
    if ((await proxmox.status(guest.node, vm.vmid))?.status !== 'running') return { intact: false, reason: 'NOT_RUNNING' };
    const probe = parseJsonOutput(await proxmox.guestRun(guest.node, vm.vmid, READINESS_PROBE_SCRIPT));
    const verdict = evaluateReadiness(probe, { poolVmId: vm.id, revision: vm.revision });
    return verdict.ready ? { intact: true } : { intact: false, reason: verdict.code };
  } catch (error) {
    return { intact: false, reason: 'CHECK_FAILED', detail: error.message };
  }
}

// Returns { status, released, toDelete, checks }. The checks are independent: run in parallel.
export async function cancelPoolRequestVerified({ db, proxmox, requestId }) {
  const reserved = (await db.query(
    `SELECT * FROM windows_pool_vms WHERE request_id = $1 AND state = 'reserved'`, [requestId])).rows;
  const checks = await Promise.all(reserved.map(async vm => ({ id: vm.id, vmid: vm.vmid, ...(await verifyReservedVmIntact(proxmox, vm)) })));
  const result = await cancelPoolRequest(db, requestId, { verifiedIntactIds: checks.filter(check => check.intact).map(check => check.id) });
  return { ...result, checks };
}
