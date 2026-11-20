// Simulated Proxmox for the Windows pool tests (clone, tasks, config, power, QGA agent, volumes).
// Reproduces the behaviours observed on the real infrastructure (P0/P2).
import { setTimeout as sleep } from 'node:timers/promises';
import { ProxmoxError } from '../../lib/windowsPool/proxmox.js';

// templates: source template VMIDs present on the cluster (all on pve-a).
// nodes: cluster nodes (cluster/resources?type=node); storages: storage -> nodes that see it.
export function fakeProxmox({ cloneMs = 400, prepMs = 150, agentDelayMs = 30, templates = [147],
  nodes = [{ node: 'pve-a', status: 'online', mem: 0, maxmem: 256 * 1024 ** 3 }], storages = { 'ceph-pool': null } } = {}) {
  const ha = new Map(); // 'vm:N' -> state
  const guests = new Map();
  const tasks = new Map();
  const hidden = new Set(); // guests invisible to the inventory but known to the registry
  const volumes = [];
  const execs = new Map();
  const log = [];
  const stats = { clones: 0, activeClones: 0, maxActiveClones: 0, cloneCalls: [], preparingNow: 0, maxPreparing: 0, execBodies: [], events: [] };
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
    if (path === 'cluster/resources?type=vm') return [...guests].map(([vmid, g]) => ({ vmid, node: g.node, type: 'qemu', name: g.config.name, template: g.template ? 1 : 0, ...(g.pool ? { pool: g.pool } : {}) }));
    if (path === 'cluster/resources?type=node') return nodes.map(n => ({ type: 'node', id: `node/${n.node}`, ...n }));
    if (path === 'cluster/resources?type=storage') {
      return Object.entries(storages).flatMap(([storage, on]) => (on ?? nodes.map(n => n.node))
        .map(node => ({ type: 'storage', id: `storage/${node}/${storage}`, storage, node, status: 'available' })));
    }
    if (path === 'cluster/ha/resources' && method === 'POST') {
      if (ha.has(body.sid)) throw new ProxmoxError(500, `resource ID '${body.sid}' already defined`);
      ha.set(body.sid, body.state); stats.events.push({ vmid: Number(body.sid.slice(3)), at: 'ha-add', state: body.state, t: now() });
      return null;
    }
    if ((m = path.match(/^cluster\/ha\/resources\/(.+)$/))) {
      const sid = decodeURIComponent(m[1]);
      // Real PVE 9 messages (DELETE seen in dev on lab 187).
      if (!ha.has(sid)) throw new ProxmoxError(500, method === 'DELETE' ? `cannot delete service '${sid}', not HA managed!` : `no such resource '${sid}'`);
      if (method === 'DELETE') { ha.delete(sid); stats.events.push({ vmid: Number(sid.slice(3)), at: 'ha-remove', t: now() }); return null; }
      if (method === 'PUT') { ha.set(sid, body.state); return null; }
      return { sid, state: ha.get(sid) };
    }
    if (path === 'pools' && method === 'PUT') {
      // Proxmox >= 8.1: move VMs into a pool (allow-move required if they are already in another one).
      for (const id of String(body.vms).split(',').map(Number)) {
        const g = guest(id);
        if (g.pool && g.pool !== body.poolid && !Number(body['allow-move'])) throw new ProxmoxError(500, `VM ${id} is already a pool member`);
        stats.events.push({ vmid: id, at: 'pool-move', from: g.pool ?? null, to: body.poolid, t: now() });
        g.pool = body.poolid;
      }
      return null;
    }
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
      guests.set(id, { node: body.target, status: 'stopped', lock: 'clone', history: [], pool: body.pool,
        config: { ...src.config, template: undefined, name: body.name, description: body.description, digest: 'd1' } });
      return task(m[1], 'qmclone', id, cloneMs, () => { stats.activeClones -= 1; delete guests.get(id).lock; });
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/config$/))) {
      const g = guest(m[2]);
      if (method === 'GET') return { ...g.config, ...(g.lock ? { lock: g.lock } : {}) };
      const { delete: del, digest, ...rest } = body;
      if (rest.net0 && /link_down=0/.test(rest.net0) && !/link_down=0/.test(g.config.net0 ?? '')) stats.events.push({ vmid: Number(m[2]), at: 'connect', t: now() });
      Object.assign(g.config, rest);
      for (const key of String(del ?? '').split(',').filter(Boolean)) delete g.config[key];
      g.history.push({ at: 'config', config: { ...g.config } });
      return null;
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/status\/current$/))) return { status: guest(m[2]).status };
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/status\/(start|stop|reboot)$/)) && method === 'POST') {
      const g = guest(m[2]);
      return task(m[1], `qm${m[3]}`, m[2], 10, () => {
        if (m[3] === 'reboot') {
          g.history.push({ at: 'reboot', config: { ...g.config } });
          g.bootAt = now(); g.doneCounted = true;
        } else if (m[3] === 'start') {
          g.history.push({ at: 'start', config: { ...g.config } });
          stats.events.push({ vmid: Number(m[2]), at: 'boot', t: now(), linkDown: /link_down=1/.test(g.config.net0 ?? '') });
          g.status = 'running'; g.bootAt = now();
          stats.preparingNow += 1; stats.maxPreparing = Math.max(stats.maxPreparing, stats.preparingNow);
        } else { g.status = 'stopped'; stats.events.push({ vmid: Number(m[2]), at: 'stop', t: now(), ha: ha.has(`vm:${m[2]}`), linkDown: /link_down=1/.test(g.config.net0 ?? '') }); }
      });
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/agent\/exec$/)) && method === 'POST') {
      const g = guest(m[2]);
      if (g.status !== 'running' || now() - g.bootAt < agentDelayMs) throw new ProxmoxError(500, 'QEMU guest agent is not running');
      const script = Buffer.from(body.command.at(-1), 'base64').toString('utf16le');
      stats.execBodies.push(body);
      const pid = ++seq;
      let out;
      let exitcode = 0;
      const connected = /link_down=0/.test(g.config.net0 ?? '');
      g.net ??= { dhcp: 'Enabled', enableDhcp: 1, ip: null, prefix: null, gateway: null, dns: [] };
      const apipa = { ip: '169.254.172.144', prefix: 16, origin: 'WellKnown' };
      const readPassword = () => { if (body['input-data']) g.adminPassword = JSON.parse(body['input-data']).password; };
      if (script.includes('EnableDHCP -Value 0')) {
        stats.events.push({ vmid: Number(m[2]), at: 'guest-network', linkDown: !connected, t: now() });
        if (connected) { exitcode = 1; out = ''; } else {
          const [, ip, mask, gateway] = /address=([\d.]+) mask=([\d.]+) gateway=([\d.]+)/.exec(script);
          const prefix = mask.split('.').reduce((n, part) => n + Number(part).toString(2).split('1').length - 1, 0);
          const dns = [...(/-ServerAddresses ((?:'[^']+',?)+)/.exec(script)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(x => x[1]);
          Object.assign(g.net, g.dhcpDefect ? { dhcp: 'Enabled', enableDhcp: 1 } : { dhcp: 'Disabled', enableDhcp: 0 }, { ip, prefix, gateway, dns });
          readPassword();
          out = JSON.stringify({ nic: 'Disconnected', dhcp: g.net.dhcp, enableDhcp: g.net.enableDhcp, addresses: [apipa, { ip, prefix }], gateways: [gateway], dns });
        }
      } else if (script.includes('EnableDHCP -Value 1')) {
        stats.events.push({ vmid: Number(m[2]), at: 'guest-network', linkDown: !connected, t: now() });
        Object.assign(g.net, { dhcp: 'Enabled', enableDhcp: 1, ip: null });
        readPassword();
        out = JSON.stringify({ nic: connected ? 'Up' : 'Disconnected', dhcp: 'Enabled', enableDhcp: 1, addresses: [apipa] });
      } else if (script.includes('Get-NetIPAddress -IPAddress')) {
        stats.events.push({ vmid: Number(m[2]), at: 'post-connect', linkDown: !connected, t: now() });
        out = JSON.stringify({ state: g.ipConflict ? 'Duplicate' : (connected ? 'Preferred' : 'Tentative'), count: connected ? 1 : 2 });
      } else if (script.includes('origin=') && script.includes('$nic=@(Get-NetAdapter')) {
        out = JSON.stringify({ addresses: connected ? [{ ip: '10.10.99.50', state: 'Preferred', origin: 'Dhcp' }] : [{ ...apipa, state: 'Tentative' }] });
      } else if (script.includes('pool-ready.json') && script.includes('Set-Content')) {
        const id = /poolVmId='([0-9a-f-]+)'/.exec(script)[1];
        const revision = Number(/revision=(\d+)/.exec(script)[1]);
        g.marker = { poolVmId: id, revision };
        out = JSON.stringify({ cloudbase: 'Disabled' });
      } else if (script.includes('ImageState')) {
        out = JSON.stringify(probeFor(Number(m[2]), g));
      } else out = '{}';
      execs.set(pid, { exited: 1, exitcode, 'out-data': out, ...(exitcode ? { 'err-data': 'NIC_CONNECTED' } : {}) });
      return { pid };
    }
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/agent\/exec-status\?pid=(\d+)$/))) return execs.get(Number(m[3]));
    if ((m = path.match(/^nodes\/([^/]+)\/qemu\/(\d+)\?purge=1/)) && method === 'DELETE') {
      const id = Number(m[2]);
      stats.events.push({ vmid: id, at: 'destroy', ha: ha.has(`vm:${id}`), t: now() });
      return task(m[1], 'qmdestroy', id, 10, () => { const g = guests.get(id); if (g?.bootAt && !g.doneCounted) stats.preparingNow -= 1; guests.delete(id); });
    }
    throw new Error(`Fake Proxmox: unexpected route ${method} ${path}`);
  };
  return { request, guests, tasks, hidden, volumes, log, stats, task, ha, nodes };
}
