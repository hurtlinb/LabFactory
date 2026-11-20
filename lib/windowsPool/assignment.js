import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { tryJobLocks } from '../jobConcurrency.js';
import { transitionPoolVm } from './states.js';
import { tryAcquireLease, releaseLease } from './leases.js';
import { ownershipMarker } from './vmidAllocator.js';
import {
  GUEST_TIMEOUTS, READINESS_PROBE_SCRIPT, evaluateReadiness, parseJsonOutput,
  buildNetworkAssignmentScript, evaluatePreConnect, buildPostConnectScript, evaluatePostConnect,
  buildDhcpAssignmentScript, evaluateDhcpPreConnect, buildDhcpPostConnectScript, evaluateDhcpPostConnect
} from './qga.js';

// Assignment of a reserved pool VM to a lab slot (lot P4a).
// One independent chain per VM (no global lock), in this order:
//   1. Proxmox: lab name/tags/description (ownership marker kept), VLAN, resources and
//      additional disk; reboot if needed, NETWORK STILL DISCONNECTED, then QGA re-check;
//   2. QGA: IP/prefix/gateway/DNS (or DHCP) + final password (stdin), check with the link down;
//   3. Proxmox: NIC connection;
//   4. QGA: post-connection check (one Preferred IPv4, no conflict);
//   5. WinRM from the worker (injected check);
//   6. transition configuring -> assigned + lab_vm_assignments row (same transaction).
// Before every mutation: the pool request must still be 'reserved' (cancellation).
// Failure: NIC disconnected again (best effort), VM quarantined (it was modified for a lab:
// never returned to the stock), error raised to the caller (the slot needs a new VM).
// Resume: the steps are idempotent; a VM already 'configuring' for the same slot starts again from 1.

export class AssignmentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const DEFAULTS = Object.freeze({
  leaseRetryMs: 2_000,
  rebootTimeoutMs: 15 * 60_000,
  dhcpTimeoutMs: 90_000,
  connectSettleMs: 3_000,
  winrmTimeoutMs: 5 * 60_000,
  winrmRetryMs: 10_000,
  guestRetryMs: GUEST_TIMEOUTS.agentRetryMs
});

export const SECOND_DISK_SERIAL = 'lf-disk2';
const netKeys = config => Object.keys(config ?? {}).filter(key => /^net\d+$/.test(key));
const withNetOptions = (value, { tag, linkDown }) => {
  let next = String(value).replace(/,tag=\d+/g, '').replace(/,link_down=\d/g, '');
  if (tag) next += `,tag=${tag}`;
  return `${next},link_down=${linkDown ? 1 : 0}`;
};

function validateSlot(slot) {
  const required = ['requestId', 'deploymentId', 'workstationNumber', 'blueprintVmId', 'name', 'adminUser', 'password', 'network'];
  for (const key of required) if (slot?.[key] === undefined || slot[key] === null || slot[key] === '') throw new AssignmentError('SLOT_INVALID', `Incomplete slot: ${key}`);
  if (!/^[A-Za-z0-9.-]{1,63}$/.test(slot.name)) throw new AssignmentError('SLOT_INVALID', 'Invalid Proxmox VM name');
  if (slot.vlanTag != null && !(Number.isInteger(slot.vlanTag) && slot.vlanTag >= 1 && slot.vlanTag <= 4094)) throw new AssignmentError('SLOT_INVALID', 'Invalid VLAN');
  if (!['static', 'dhcp'].includes(slot.network.mode)) throw new AssignmentError('SLOT_INVALID', 'Unknown network mode');
}

export function createPoolAssigner({ db, proxmox, holder, winrmCheck, log = console, options = {} }) {
  if (typeof winrmCheck !== 'function') throw new Error('A WinRM check is required');
  const opts = { ...DEFAULTS, ...options };

  async function waitFor(acquire, signal, label) {
    for (;;) {
      signal?.throwIfAborted();
      const value = await acquire();
      if (value) return value;
      await sleep(opts.leaseRetryMs, undefined, { signal });
      log.debug?.(`[windows-pool] waiting for ${label}`);
    }
  }

  const assertRequestReserved = async requestId => {
    const row = (await db.query('SELECT status FROM windows_pool_requests WHERE id = $1', [requestId])).rows[0];
    if (row?.status !== 'reserved') throw new AssignmentError('REQUEST_NOT_RESERVED', `Pool request ${requestId} ${row?.status ?? 'unknown'}: assignment interrupted`);
  };

  const guestJson = async (node, vmid, script, { input, secrets = [], timeoutMs = GUEST_TIMEOUTS.assignmentMs, signal } = {}) =>
    parseJsonOutput(await proxmox.guestRun(node, vmid, script, { input, secrets, timeoutMs, signal }));

  async function waitGuestReady(vm, node, signal) {
    const deadline = Date.now() + opts.rebootTimeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const verdict = evaluateReadiness(await guestJson(node, vm.vmid, READINESS_PROBE_SCRIPT, { timeoutMs: GUEST_TIMEOUTS.probeMs, signal }), { poolVmId: vm.id, revision: vm.revision });
        if (verdict.ready) return;
        if (verdict.fatal) throw new AssignmentError(verdict.code, `Guest not compliant after reboot: ${verdict.code}`);
      } catch (error) {
        if (error instanceof AssignmentError) throw error;
      }
      if (Date.now() > deadline) throw new AssignmentError('REBOOT_TIMEOUT', 'Guest not ready after reboot');
      await sleep(opts.guestRetryMs, undefined, { signal });
    }
  }

  // Step 1: Proxmox configuration (network still disconnected).
  async function configureProxmox(vm, slot, signal) {
    const guest = await proxmox.findGuest(vm.vmid);
    if (!guest) throw new AssignmentError('VM_ABSENT', `VM ${vm.vmid} absent`);
    const config = await proxmox.getConfig(guest.node, vm.vmid);
    if (!String(config.description ?? '').includes(ownershipMarker(vm.id))) throw new AssignmentError('OWNERSHIP_LOST', 'Ownership marker missing');
    if (config.lock) throw new AssignmentError('VM_LOCKED', `VM locked (${config.lock})`);
    const nets = netKeys(config);
    if (!nets.length) throw new AssignmentError('NO_NIC', 'VM without a NIC');
    const patch = {
      name: slot.name,
      tags: [...new Set(['labfactory-pool', ...(slot.tags ?? [])])].join(';'),
      description: `${ownershipMarker(vm.id)}\nLabFactory lab ${slot.deploymentId}, workstation ${String(slot.workstationNumber).padStart(2, '0')}, VM ${slot.blueprintVmId}`,
      digest: config.digest
    };
    // Every NIC stays disconnected; the lab VLAN is applied to net0, the other NICs keep theirs.
    for (const key of nets) {
      const existingTag = Number((/tag=(\d+)/.exec(config[key]) ?? [])[1]) || null;
      patch[key] = withNetOptions(config[key], { tag: key === 'net0' ? slot.vlanTag : existingTag, linkDown: true });
    }
    let needsReboot = false;
    if (slot.resources?.cores && Number(config.cores) !== slot.resources.cores) { patch.cores = slot.resources.cores; needsReboot = true; }
    if (slot.resources?.memory && Number(config.memory) !== slot.resources.memory) { patch.memory = slot.resources.memory; needsReboot = true; }
    if (slot.secondDisk?.sizeGb && !Object.values(config).some(value => String(value).includes(`serial=${SECOND_DISK_SERIAL}`))) {
      const used = new Set(Object.keys(config).filter(key => /^scsi\d+$/.test(key)));
      const slotKey = [...Array(30).keys()].map(i => `scsi${i}`).find(key => !used.has(key));
      // The serial (<= 20 characters on the Proxmox side) marks the disk: idempotent step on resume.
      patch[slotKey] = `${slot.secondDisk.storage}:${slot.secondDisk.sizeGb},iothread=1,serial=${SECOND_DISK_SERIAL}`;
    }
    await proxmox.setConfig(guest.node, vm.vmid, patch);
    const check = await proxmox.getConfig(guest.node, vm.vmid);
    if (!netKeys(check).every(key => /link_down=1/.test(check[key]))) throw new AssignmentError('ISOLATION_FAILED', 'NIC connected before network configuration');
    if (slot.vlanTag && !new RegExp(`tag=${slot.vlanTag}(,|$)`).test(check.net0)) throw new AssignmentError('VLAN_FAILED', 'VLAN not applied');
    if (needsReboot) {
      const upid = await proxmox.request(`${proxmox.vmPath(guest.node, vm.vmid)}/status/reboot`, { method: 'POST' });
      await proxmox.waitTask(upid, { timeoutMs: opts.rebootTimeoutMs, signal });
      await sleep(opts.connectSettleMs, undefined, { signal });
      await waitGuestReady(vm, guest.node, signal);
    }
    return { node: guest.node, mac: /^[a-z0-9]+=([0-9A-Fa-f:]{17})/.exec(check.net0)?.[1] ?? vm.mac };
  }

  // Steps 2 to 4: guest network (link down), connection, post-connection check.
  async function configureNetwork(vm, slot, node, mac, signal) {
    const secrets = [slot.password];
    const input = { password: slot.password };
    if (slot.network.mode === 'static') {
      const params = { mac, ipAddress: slot.network.ipAddress, prefixLength: slot.network.prefixLength, gateway: slot.network.gateway, dnsServers: slot.dnsServers };
      const pre = evaluatePreConnect(await guestJson(node, vm.vmid, buildNetworkAssignmentScript(params, { adminUser: slot.adminUser }), { input, secrets, signal }), params);
      if (!pre.ready) throw new AssignmentError(pre.code, pre.detail ?? pre.code);
    } else {
      const pre = evaluateDhcpPreConnect(await guestJson(node, vm.vmid, buildDhcpAssignmentScript({ mac }, { adminUser: slot.adminUser }), { input, secrets, signal }));
      if (!pre.ready) throw new AssignmentError(pre.code, pre.detail ?? pre.code);
    }
    await assertRequestReserved(slot.requestId);
    const config = await proxmox.getConfig(node, vm.vmid);
    await proxmox.setConfig(node, vm.vmid, { net0: withNetOptions(config.net0, { tag: slot.vlanTag, linkDown: false }), digest: config.digest });
    await sleep(opts.connectSettleMs, undefined, { signal });
    if (slot.network.mode === 'static') {
      const post = evaluatePostConnect(await guestJson(node, vm.vmid, buildPostConnectScript(slot.network.ipAddress), { signal }));
      if (!post.ready) throw new AssignmentError(post.code, post.detail ?? post.code);
      return slot.network.ipAddress;
    }
    const deadline = Date.now() + opts.dhcpTimeoutMs;
    for (;;) {
      const post = evaluateDhcpPostConnect(await guestJson(node, vm.vmid, buildDhcpPostConnectScript({ mac }), { signal }));
      if (post.ready) return post.ipAddress;
      if (post.fatal) throw new AssignmentError(post.code, post.detail ?? post.code);
      if (Date.now() > deadline) throw new AssignmentError('DHCP_TIMEOUT', 'No DHCP lease after connecting');
      await sleep(opts.connectSettleMs, undefined, { signal });
    }
  }

  async function verifyWinrm(slot, ipAddress, signal) {
    const deadline = Date.now() + opts.winrmTimeoutMs;
    let lastError;
    for (;;) {
      signal?.throwIfAborted();
      try { await winrmCheck({ ipAddress, username: slot.adminUser, password: slot.password, signal }); return; }
      catch (error) { lastError = error; }
      if (Date.now() > deadline) throw new AssignmentError('WINRM_FAILED', `WinRM unavailable on ${ipAddress}: ${lastError?.message ?? ''}`);
      await sleep(opts.winrmRetryMs, undefined, { signal });
    }
  }

  // Step 6: assigned + assignment row, atomically. Returns the assignment.
  async function recordAssignment(vm, slot, node, ipAddress) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query('SELECT * FROM windows_pool_vms WHERE id = $1 FOR UPDATE', [vm.id])).rows[0];
      await transitionPoolVm(client, { id: vm.id, from: 'configuring', to: 'assigned', version: current.version,
        detail: { deploymentId: slot.deploymentId, workstation: slot.workstationNumber, ipAddress } });
      const settings = (await client.query('SELECT cluster FROM windows_pool_settings WHERE id')).rows[0];
      if (slot.replacesAssignmentId) {
        // Redeploy: the old assignment is closed and its VM sent to destruction in the SAME
        // transaction as the new one (a single active assignment per slot, never zero).
        const previous = (await client.query(
          `UPDATE lab_vm_assignments SET status = 'replaced', ended_at = NOW()
            WHERE id = $1 AND status = 'active' RETURNING pool_vm_id`, [slot.replacesAssignmentId])).rows[0];
        if (previous?.pool_vm_id) {
          const old = (await client.query('SELECT * FROM windows_pool_vms WHERE id = $1 FOR UPDATE', [previous.pool_vm_id])).rows[0];
          if (old && ['assigned', 'configuring'].includes(old.state)) {
            await transitionPoolVm(client, { id: old.id, from: old.state, to: 'deleting', version: old.version,
              detail: { code: 'REPLACED', replacedBy: vm.id } });
          }
        }
      }
      const assignment = (await client.query(
        `INSERT INTO lab_vm_assignments (id, deployment_id, workstation_number, blueprint_vm_id, manager, cluster, node, vmid, pool_vm_id, request_id, replaces_assignment_id)
         VALUES ($1, $2, $3, $4, 'windows-pool', $5, $6, $7, $8, $9, $10) RETURNING *`,
        [randomUUID(), slot.deploymentId, slot.workstationNumber, slot.blueprintVmId, settings.cluster, node, vm.vmid, vm.id, slot.requestId, slot.replacesAssignmentId ?? null])).rows[0];
      await client.query('COMMIT');
      return assignment;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async function quarantineAfterFailure(vm, error) {
    try {
      const guest = await proxmox.findGuest(vm.vmid);
      if (guest) {
        const config = await proxmox.getConfig(guest.node, vm.vmid);
        const patch = { digest: config.digest };
        for (const key of netKeys(config)) patch[key] = withNetOptions(config[key], { tag: (/tag=(\d+)/.exec(config[key]) ?? [])[1], linkDown: true });
        await proxmox.setConfig(guest.node, vm.vmid, patch);
      }
    } catch (disconnectError) {
      log.error?.(`[windows-pool] VM ${vm.vmid}: re-disconnection failed after an error: ${disconnectError.message}`);
    }
    const current = (await db.query('SELECT * FROM windows_pool_vms WHERE id = $1', [vm.id])).rows[0];
    // 'deleting' (concurrent cancellation) or other: left to the manager.
    if (current?.state === 'configuring') {
      await transitionPoolVm(db, { id: vm.id, from: current.state, to: 'quarantined', version: current.version,
        detail: { code: error.code ?? 'ASSIGNMENT_FAILED' },
        patch: { error_code: error.code ?? 'ASSIGNMENT_FAILED', last_error: String(error.message).slice(0, 1000) } }).catch(() => undefined);
    }
  }

  // Assigns one VM to one slot. Returns { assignment, ipAddress, vmid }.
  async function assign(poolVmId, slot, { signal } = {}) {
    validateSlot(slot);
    if (slot.network.mode === 'static' && !slot.dnsServers?.length) throw new AssignmentError('SLOT_INVALID', 'DNS required in static mode');
    const lock = await waitFor(() => tryJobLocks(db, [`pool-vm:${poolVmId}`]), signal, `pool-vm:${poolVmId}`);
    let vm;
    let touched = false; // true as soon as the VM is 'configuring': it can no longer return to the stock
    try {
      vm = (await db.query('SELECT * FROM windows_pool_vms WHERE id = $1', [poolVmId])).rows[0];
      if (!vm) throw new AssignmentError('VM_UNKNOWN', `Unknown pool VM ${poolVmId}`);
      if (vm.state === 'assigned' && vm.request_id === slot.requestId) {
        const existing = (await db.query(`SELECT * FROM lab_vm_assignments WHERE pool_vm_id = $1`, [vm.id])).rows[0];
        return { assignment: existing, vmid: vm.vmid, resumed: true };
      }
      await assertRequestReserved(slot.requestId);
      if (vm.request_id !== slot.requestId) throw new AssignmentError('VM_NOT_RESERVED_FOR_REQUEST', `VM ${vm.vmid} is not reserved for this request`);
      if (vm.state === 'reserved') {
        vm = await transitionPoolVm(db, { id: vm.id, from: 'reserved', to: 'configuring', version: vm.version,
          detail: { deploymentId: slot.deploymentId, workstation: slot.workstationNumber, blueprintVmId: slot.blueprintVmId } });
      } else if (vm.state !== 'configuring') {
        throw new AssignmentError('VM_STATE', `VM ${vm.vmid} in state ${vm.state}`);
      }
      touched = true;
      const lease = await waitFor(() => tryAcquireLease(db, { category: 'assign', holder, poolVmId: vm.id, ttlSeconds: 1800 }), signal, 'lease assign');
      try {
        const { node, mac } = await configureProxmox(vm, slot, signal);
        if (!mac) throw new AssignmentError('NO_MAC', 'MAC address unknown');
        const ipAddress = await configureNetwork(vm, slot, node, mac, signal);
        await verifyWinrm(slot, ipAddress, signal);
        await assertRequestReserved(slot.requestId);
        const assignment = await recordAssignment(vm, slot, node, ipAddress);
        return { assignment, ipAddress, vmid: vm.vmid };
      } finally {
        await releaseLease(db, lease);
      }
    } catch (error) {
      // A reserved but untouched VM stays reserved (intact, a cancellation can release it).
      if (vm && touched) await quarantineAfterFailure(vm, error);
      throw error;
    } finally {
      await lock.release();
    }
  }

  return { assign };
}
