// Simulated Proxmox for the Windows pool tests (clone, tasks, config, power, QGA agent, volumes).
// Reproduces the behaviours observed on the real infrastructure (P0/P2).
import { setTimeout as sleep } from 'node:timers/promises';
import { ProxmoxError } from '../../lib/windowsPool/proxmox.js';

// templates: source template VMIDs present on the cluster (all on pve-a).
export function fakeProxmox({ cloneMs = 400, prepMs = 150, agentDelayMs = 30, templates = [147] } = {}) {
  const guests = new Map();
  const tasks = new Map();
  const hidden = new Set(); // guests invisible to the inventory but known to the registry
  const volumes = [];
  const execs = new Map();
  const log = [];
  const stats = { clones: 0, activeClones: 0, maxActiveClones: 0, cloneCalls: [], preparingNow: 0, maxPreparing: 0 };
  let seq = 0;
  const now = () => Date.now();
  for (const vmid of templates) {
    guests.set(vmid, { node: 'pve-a', template: true, status: 'stopped',
      config: { name: `Tmpl${vmid}`, template: 1, net0: 'virtio=AA:AA:AA:AA:AA:AA,bridge=vmbr0,firewall=1', digest: 'd0' } });
  }
  const task = (node, type, vmid, ms, onDone, exitstatus = 'OK') => {
    const upid = `UPID:${node}:${(++seq).toString(16)}:${type}:${vmid}:`;
    tasks.set(upid, { status: 'running' });
    setTimeout(() => { onDone?.(); tasks.set(upid, { status: 'stopped', exitstatus }); }, ms);
    return upid;
  };
  const guest = vmid => { const g = guests.get(Number(vmid)); if (!g) throw new ProxmoxError(500, `Configuration file 'qemu-server/${vmid}.conf' does not exist`); return g; };
  const probeFor = (vmid, g) => {
    const elapsed = now() - g.bootAt;
    const base = { setup: 0, oobe: 0, cloudbase: 'Stopped', flag: true, doneLog: true, errorCount: 0, pendingCbs: false, pendingWU: false,
      plugins: { NetworkConfigPlugin: 1, SetUserPasswordPlugin: 1, ConfigWinRMListenerPlugin: 1, LocalScriptsPlugin: 1 },
      nic: [{ MacAddress: 'BC-24-11-00-00-01', Status: 'Disconnected' }], marker: g.marker ?? null };
    if (elapsed < prepMs) return { ...base, state: 'IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE', setup: 1, oobe: 1, flag: false, doneLog: false, errorCount: -1 };
    // End of the preparation from the guest's point of view: bootstrap finished and marker present.
    if (g.marker && !g.doneCounted) { g.doneCounted = true; stats.preparingNow -= 1; }
    return { ...base, state: 'IMAGE_STATE_COMPLETE', ...(g.probeOverride ?? {}) };
  };
  const request = async (path, { method = 'GET', body } = {}) => {
    await sleep(1);
    log.push(`${method} ${path}`);
    let m;
    if ((m = path.match(/^cluster\/nextid\?vmid=(\d+)$/))) {
      const id = Number(m[1]);
      if (guests.has(id) || hidden.has(id)) throw new ProxmoxError(400, `VM ${id} already exists`);
      return id;
    }
    if (path === 'cluster/resources?type=vm') return [...guests].map(([vmid, g]) => ({ vmid, node: g.node, type: 'qemu', name: g.config.name, template: g.template ? 1 : 0 }));
    if ((m = path.match(/^nodes\/[^/]+\/storage\/[^/]+\/content\/(.+)$/))) {
      if (stats.storageDown) throw new ProxmoxError(596, 'Connection timed out');
      const volid = decodeURIComponent(m[1]);
      if (volumes.some(v => v.volid === volid)) return { format: 'raw' };
      throw new ProxmoxError(500, `rbd error: rbd: error opening image ${volid}: (2) No such file or directory`);
    }
    if ((m = path.match(/^nodes\/([^/]+)\/tasks\/([^/]+)\/status$/))) return tasks.get(decodeURIComponent(m[2])) ?? Promise.reject(new ProxmoxError(404, 'no such task'));
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/clone$/)) && method === 'POST') {
      const id = Number(body.newid);
      if (guests.has(id)) throw new ProxmoxError(500, `VM ${id} already exists`);
      stats.clones += 1; stats.cloneCalls.push({ ...body });
      stats.activeClones += 1; stats.maxActiveClones = Math.max(stats.maxActiveClones, stats.activeClones);
      const src = guest(m[2]);
      guests.set(id, { node: body.target, status: 'stopped', lock: 'clone', history: [],
        config: { ...src.config, template: undefined, name: body.name, description: body.description, digest: 'd1' } });
      return task(m[1], 'qmclone', id, cloneMs, () => { stats.activeClones -= 1; delete guests.get(id).lock; });
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/config$/))) {
      const g = guest(m[2]);
      if (method === 'GET') return { ...g.config, ...(g.lock ? { lock: g.lock } : {}) };
      const { delete: del, digest, ...rest } = body;
      Object.assign(g.config, rest);
      for (const key of String(del ?? '').split(',').filter(Boolean)) delete g.config[key];
      g.history.push({ at: 'config', config: { ...g.config } });
      return null;
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/status\/current$/))) return { status: guest(m[2]).status };
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/status\/(start|stop)$/)) && method === 'POST') {
      const g = guest(m[2]);
      return task(m[1], `qm${m[3]}`, m[2], 10, () => {
        if (m[3] === 'start') {
          g.history.push({ at: 'start', config: { ...g.config } });
          g.status = 'running'; g.bootAt = now();
          stats.preparingNow += 1; stats.maxPreparing = Math.max(stats.maxPreparing, stats.preparingNow);
        } else { g.status = 'stopped'; }
      });
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/agent\/exec$/)) && method === 'POST') {
      const g = guest(m[2]);
      if (g.status !== 'running' || now() - g.bootAt < agentDelayMs) throw new ProxmoxError(500, 'QEMU guest agent is not running');
      const script = Buffer.from(body.command.at(-1), 'base64').toString('utf16le');
      const pid = ++seq;
      let out;
      if (script.includes('pool-ready.json') && script.includes('Set-Content')) {
        const id = /poolVmId='([0-9a-f-]+)'/.exec(script)[1];
        const revision = Number(/revision=(\d+)/.exec(script)[1]);
        g.marker = { poolVmId: id, revision };
        out = JSON.stringify({ cloudbase: 'Disabled' });
      } else if (script.includes('ImageState')) {
        out = JSON.stringify(probeFor(Number(m[2]), g));
      } else out = '{}';
      execs.set(pid, { exited: 1, exitcode: 0, 'out-data': out });
      return { pid };
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/agent\/exec-status\?pid=(\d+)$/))) return execs.get(Number(m[3]));
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\?purge=1/)) && method === 'DELETE') {
      const id = Number(m[2]);
      return task(m[1], 'qmdestroy', id, 10, () => { const g = guests.get(id); if (g?.bootAt && !g.doneCounted) stats.preparingNow -= 1; guests.delete(id); });
    }
    throw new Error(`Fake Proxmox: unexpected route ${method} ${path}`);
  };
  return { request, guests, tasks, hidden, volumes, log, stats, task };
}
