import http from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildGuestExecRequest, parseGuestExecStatus, GUEST_TIMEOUTS } from './qga.js';

// Minimal Proxmox client for the Windows pool. `request(path, options)` returns `data`.
// Errors carry `status` and `proxmoxMessage` to tell transient errors from definitive ones.

export class ProxmoxError extends Error {
  constructor(status, message) {
    super(`Proxmox HTTP ${status}: ${message}`);
    this.status = status;
    this.proxmoxMessage = message;
  }
}

export const isTransientProxmoxError = error =>
  /cfs-lock|got lock request timeout|can't lock file|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(String(error?.message ?? '')) ||
  [502, 503, 504].includes(error?.status);
export const isAgentUnavailable = error => /guest agent is not running|QEMU guest agent|VM \d+ is not running/i.test(String(error?.message ?? ''));
export const isMissingVm = error => /does not exist|no such VM|not found/i.test(String(error?.message ?? ''));

export function createHttpRequest({ apiUrl, tokenId, tokenSecret, tlsInsecure = false, timeoutMs = 20_000 }) {
  if (!apiUrl || !tokenId || !tokenSecret) throw new Error('Incomplete Proxmox configuration');
  const base = `${String(apiUrl).replace(/\/+$/, '')}/`;
  return (path, { method = 'GET', body, signal, timeoutMs: callTimeoutMs } = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
    }
    const data = body ? params.toString() : null;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      signal,
      rejectUnauthorized: !tlsInsecure,
      headers: {
        Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
        ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let payload = null;
        try { payload = raw ? JSON.parse(raw) : null; } catch { /* non-JSON response */ }
        if ((response.statusCode ?? 500) >= 400) {
          const message = payload?.errors ? JSON.stringify(payload.errors) : (payload?.message ?? response.statusMessage ?? raw.slice(0, 300));
          reject(new ProxmoxError(response.statusCode, String(message).trim()));
          return;
        }
        resolve(payload?.data ?? null);
      });
    });
    req.setTimeout(callTimeoutMs ?? timeoutMs, () => req.destroy(new Error('Proxmox request timeout')));
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

// Storage of the system disk of a Proxmox template ("ceph-pool:base-152-disk-1,iothread=1" ->
// "ceph-pool"): the linked clones of the pool live on it. First data disk (scsi/virtio/sata/ide,
// numeric order), CD-ROMs and EFI/TPM disks ignored; null if none.
export function templateDiskStorage(config) {
  const disk = Object.keys(config ?? {})
    .filter(key => /^(scsi|virtio|sata|ide)\d+$/.test(key))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(key => String(config[key]))
    .find(value => !/media=cdrom/.test(value) && /^[A-Za-z0-9._-]+:/.test(value));
  return disk ? disk.split(':')[0] : null;
}

export const nodeFromUpid = upid => {
  const match = /^UPID:([^:]+):/.exec(String(upid ?? ''));
  if (!match) throw new Error(`Invalid UPID: ${upid}`);
  return match[1];
};

export function createPoolProxmox(request, { taskPollMs = 2_000, guestPollMs = GUEST_TIMEOUTS.pollIntervalMs } = {}) {
  const vmPath = (node, vmid) => `nodes/${encodeURIComponent(node)}/qemu/${vmid}`;

  const taskStatus = async upid => request(`nodes/${encodeURIComponent(nodeFromUpid(upid))}/tasks/${encodeURIComponent(upid)}/status`);

  // 'running' | 'stopped' | 'unknown': used by the lease reconciliation.
  const taskState = async upid => {
    try {
      const status = await taskStatus(upid);
      return status?.status === 'stopped' ? 'stopped' : status?.status === 'running' ? 'running' : 'unknown';
    } catch (error) {
      return isMissingVm(error) || error?.status === 404 ? 'stopped' : 'unknown';
    }
  };

  // Waits for a task. Never cancels a running Proxmox task (lesson from P0: an
  // interrupted qmclone leaves a locked VM and can block the storage).
  const waitTask = async (upid, { timeoutMs = 10 * 60_000, signal } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await taskStatus(upid);
      if (status?.status === 'stopped') {
        if (status.exitstatus !== 'OK') {
          throw Object.assign(new Error(`Proxmox task failed: ${status.exitstatus}`), { code: 'TASK_FAILED', exitstatus: status.exitstatus });
        }
        return status;
      }
      if (Date.now() > deadline) throw Object.assign(new Error(`Proxmox task still running: ${upid}`), { code: 'TASK_TIMEOUT' });
      await sleep(taskPollMs, undefined, { signal });
    }
  };

  // Runs a PowerShell script through QGA. Secrets: via `input` (stdin) and redacted.
  const guestRun = async (node, vmid, script, { input, secrets = [], timeoutMs = GUEST_TIMEOUTS.probeMs, signal } = {}) => {
    const { pid } = await request(`${vmPath(node, vmid)}/agent/exec`, { method: 'POST', body: buildGuestExecRequest(script, { input }), signal });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await sleep(guestPollMs, undefined, { signal });
      const result = parseGuestExecStatus(await request(`${vmPath(node, vmid)}/agent/exec-status?pid=${pid}`, { signal }), { secrets });
      if (result.exited) return result;
      if (Date.now() > deadline) throw Object.assign(new Error(`Guest command timeout (pid ${pid})`), { code: 'GUEST_TIMEOUT' });
    }
  };

  // High availability (same calls as workers/terraformWorker.js ensureVmHaState).
  const haPath = vmid => `cluster/ha/resources/${encodeURIComponent(`vm:${Number(vmid)}`)}`;
  // PVE 9 (seen in dev on DELETE): "cannot delete service 'vm:N', not HA managed!".
  const isHaMissing = error => error?.status === 404 || /no such resource|does not exist|not found|no such ha resource|not ha managed/i.test(String(error?.message ?? ''));
  const ensureHaStarted = async vmid => {
    try {
      await request(haPath(vmid), { method: 'PUT', body: { state: 'started' } });
    } catch (error) {
      if (!isHaMissing(error)) throw error;
      try {
        await request('cluster/ha/resources', { method: 'POST', body: { sid: `vm:${Number(vmid)}`, state: 'started' } });
      } catch (createError) {
        if (!/already exists|resource.*exists|duplicate/i.test(String(createError?.message ?? ''))) throw createError;
        await request(haPath(vmid), { method: 'PUT', body: { state: 'started' } });
      }
    }
  };
  // Before any stop initiated by the pool: otherwise HA would restart the VM right away.
  const removeHa = async vmid => {
    try { await request(haPath(vmid), { method: 'DELETE' }); } catch (error) { if (!isHaMissing(error)) throw error; }
  };

  return {
    request,
    vmPath,
    taskState,
    waitTask,
    guestRun,
    ensureHaStarted,
    removeHa,
    getConfig: (node, vmid) => request(`${vmPath(node, vmid)}/config`),
    setConfig: (node, vmid, body) => request(`${vmPath(node, vmid)}/config`, { method: 'PUT', body }),
    status: (node, vmid) => request(`${vmPath(node, vmid)}/status/current`),
    // Locates a guest by its VMID (node can change after migration/HA).
    findGuest: async vmid => (await request('cluster/resources?type=vm')).find(resource => Number(resource.vmid) === Number(vmid)) ?? null
  };
}
