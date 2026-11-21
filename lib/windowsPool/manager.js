import { randomBytes } from 'node:crypto';
import { tryJobLocks } from '../jobConcurrency.js';
import { transitionPoolVm } from './states.js';
import { planReplenishment, mapTemplatePoolRow } from './config.js';
import { tryAcquireLease, releaseLease, attachProxmoxTask, reconcileOrphanLeases, leaseScopes } from './leases.js';
import { allocatePoolVm, createProxmoxVmidCheck, ownershipMarker } from './vmidAllocator.js';
import { READINESS_PROBE_SCRIPT, evaluateReadiness, buildReadyMarkerScript, parseJsonOutput, GUEST_TIMEOUTS } from './qga.js';
import { isTransientProxmoxError, isAgentUnavailable, isMissingVm } from './proxmox.js';
import { STOCK_NOTIFY_CHANNEL } from './reservation.js';

// Windows pool manager (lot P2). Each tick:
//  1. reconciles the leases left by a crash (Proxmox task finished?);
//  2. drains the ready VMs of an old revision;
//  3. advances each VM of the pool (creating -> preparing -> ready, deleting -> deleted);
//  4. starts the replenishment planned by planReplenishment.
// Each VM is an independent chain: no VM waits for another one. Waits
// (preparation, backoff) hold neither a worker slot nor a lock: the VM is
// simply revisited on a later tick (checkpoint.nextAttemptAt / nextProbeAt).
// Mutations of a VM: per-VM advisory lock (`pool-vm:<id>`, shared across replicas)
// + optimistic version. Shared resources: leases (lib/windowsPool/leases.js).

const DEFAULTS = Object.freeze({
  // VM operations executed at the same time by this process. Each one holds a DEDICATED
  // connection (per-VM advisory lock) AND uses another one for its queries: must stay well below
  // the size of the PostgreSQL pool (bug seen in dev: 34 operations launched at once with a pool of
  // 20 -> 19 lock connections, the queries wait forever = worker frozen).
  maxConcurrentOperations: 6,
  // Reserve not refilled while labs are busy (user decision 2026-11-20). A status older than
  // this is ignored: a lab stuck in 'deploying' must never block the reserve forever.
  labActivityMaxAgeMs: 3 * 60 * 60_000,
  firstProbeDelayMs: 20_000,
  probeIntervalMs: GUEST_TIMEOUTS.agentRetryMs,
  retryBackoffMs: [15_000, 30_000, 60_000, 120_000, 300_000],
  maxAttempts: 6,
  cloneTimeoutMs: 15 * 60_000,
  powerTimeoutMs: 5 * 60_000,
  probeLeaseSeconds: 120,
  cloneLeaseSeconds: 300
});

// Same statuses as deploymentBusyStatuses (dashboard/server.js), minus 'waiting_for_pool'.
export const BUSY_LAB_STATUSES = Object.freeze(['queued', 'deploying', 'customizing', 'starting', 'stopping', 'destroying']);

// Demand per template: waiting labs + replacements of VMs quarantined during an assignment
// (reserved requests, migration 035). Always served, even while labs are busy (holdReserve).
const DEMAND_SQL = `
  SELECT template_id, SUM(n)::int AS n FROM (
    SELECT (d->>'templateId')::uuid AS template_id, (d->>'count')::int AS n
      FROM windows_pool_requests r, jsonb_array_elements(r.demand) d
     WHERE r.status = 'waiting_for_pool'
    UNION ALL
    SELECT x.key::uuid, x.value::int
      FROM windows_pool_requests r, jsonb_each_text(r.replacement_demand) x
     WHERE r.status = 'reserved'
  ) wanted GROUP BY 1`;

export const adminUsernameFor = language => (String(language ?? '').trim().toLowerCase() === 'fr' ? 'Administrateur' : 'Administrator');
const provisionalPassword = () => `${randomBytes(18).toString('base64url')}aA1!`;
const netKeys = config => Object.keys(config ?? {}).filter(key => /^net\d+$/.test(key));
const withLinkDown = value => `${String(value).replace(/,link_down=\d/g, '')},link_down=1`;
const macOf = value => /^[a-z0-9]+=([0-9A-Fa-f:]{17})/.exec(String(value ?? ''))?.[1]?.toUpperCase() ?? null;
const isOurs = (config, poolVmId) => String(config?.description ?? '').includes(ownershipMarker(poolVmId));

export function createPoolManager({ db, proxmox, holder, log = console, now = () => Date.now(), options = {} }) {
  if (!db || !proxmox || !holder) throw new Error('db, proxmox and holder are required');
  const opts = { ...DEFAULTS, ...options };
  const inflight = new Map(); // in-process de-duplication of the running operations
  const pendingCreations = new Map(); // templateId -> creations launched but not yet allocated
  // VMID check (registry + inventory + targeted volume lookups), one instance per node/storage.
  const vmidChecks = new Map();
  const vmidCheckFor = template => {
    const key = `${template.node}|${template.storage}`;
    if (!vmidChecks.has(key)) {
      vmidChecks.set(key, createProxmoxVmidCheck({ request: proxmox.request, node: template.node, storage: template.storage, ...(opts.vmidCheck ?? {}) }));
    }
    return vmidChecks.get(key);
  };

  // Bounded concurrency: queued operations hold neither a connection nor a lock.
  let running = 0;
  const waiting = [];
  const slot = () => (running < opts.maxConcurrentOperations
    ? (running += 1, Promise.resolve())
    : new Promise(resolve => waiting.push(resolve)));
  const freeSlot = () => {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  };
  const launch = (key, fn) => {
    if (inflight.has(key)) return;
    const promise = slot()
      .then(() => Promise.resolve().then(fn).finally(freeSlot))
      .catch(error => log.error?.(`[windows-pool] ${key}: ${error.message}`))
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
  };

  const loadVm = async id => (await db.query('SELECT * FROM windows_pool_vms WHERE id = $1', [id])).rows[0];
  const loadTemplate = async templateId => {
    const row = (await db.query(
      `SELECT p.*, t.language FROM windows_pool_templates p JOIN vm_templates t ON t.id = p.template_id WHERE p.template_id = $1`,
      [templateId])).rows[0];
    return row ? { ...mapTemplatePoolRow(row), language: row.language } : null;
  };
  const loadSettings = async () => (await db.query('SELECT * FROM windows_pool_settings WHERE id')).rows[0];

  // Checkpoint update (without a state change), under version control.
  const saveCheckpoint = async (vm, patch, extra = {}) => {
    const result = await db.query(
      `UPDATE windows_pool_vms SET checkpoint = checkpoint || $2::jsonb, version = version + 1,
              error_code = COALESCE($4, error_code), last_error = COALESCE($5, last_error)
        WHERE id = $1 AND version = $3 RETURNING *`,
      [vm.id, JSON.stringify(patch), vm.version, extra.errorCode ?? null, extra.lastError ?? null]);
    if (!result.rowCount) throw Object.assign(new Error(`Pool VM ${vm.id} changed concurrently`), { code: 'POOL_VM_STALE' });
    return result.rows[0];
  };
  const transition = (vm, to, { detail = {}, patch = {} } = {}) =>
    transitionPoolVm(db, { id: vm.id, from: vm.state, to, version: vm.version, detail, patch });
  const quarantine = (vm, code, message) => {
    log.warn?.(`[windows-pool] VM ${vm.vmid} quarantined: ${code} ${message ?? ''}`);
    return transition(vm, 'quarantined', { detail: { code }, patch: { error_code: code, last_error: message ?? code } });
  };

  // Transient error: backoff, then quarantine after maxAttempts.
  const retryLater = async (vm, error) => {
    const attempts = Number(vm.checkpoint?.attempts ?? 0) + 1;
    if (attempts >= opts.maxAttempts) return quarantine(vm, 'REPEATED_FAILURE', error.message);
    const delay = opts.retryBackoffMs[Math.min(attempts - 1, opts.retryBackoffMs.length - 1)];
    return saveCheckpoint(vm, { attempts, nextAttemptAt: now() + delay }, { lastError: String(error.message).slice(0, 1000) });
  };
  const isDue = (vm, field = 'nextAttemptAt') => !vm.checkpoint?.[field] || Number(vm.checkpoint[field]) <= now();

  // Per-VM exclusion shared across replicas (session advisory lock).
  const withVmLock = async (id, fn) => {
    const lease = await tryJobLocks(db, [`pool-vm:${id}`]);
    if (!lease) return null; // another worker is handling it
    try { return await fn(); } finally { await lease.release(); }
  };

  // ---------------------------------------------------------------- creation

  async function cloneVm(vm, template, settings, cloneLease) {
    try {
      await vmidCheckFor({ node: vm.node, storage: template.storage })(vm.vmid);
    } catch (error) {
      if (error.code === 'VOLUME_CHECK_UNAVAILABLE') throw error; // storage unavailable: retry later
      // After a crash between the POST clone and the checkpoint, the VM may be ours.
      const guest = await proxmox.findGuest(vm.vmid);
      if (guest) {
        const config = await proxmox.getConfig(guest.node, vm.vmid).catch(() => null);
        if (isOurs(config, vm.id)) return saveCheckpoint(vm, { cloned: true, node: guest.node });
      }
      // VMID taken by someone else: never adopt, never destroy (destroy() re-checks).
      return transition(vm, 'deleting', { detail: { code: 'VMID_COLLISION' }, patch: { error_code: 'VMID_COLLISION', last_error: error.message } });
    }
    const source = await proxmox.findGuest(template.sourceTemplateVmid);
    if (!source) throw new Error(`Source template ${template.sourceTemplateVmid} not found`);
    const upid = await proxmox.request(`${proxmox.vmPath(source.node, template.sourceTemplateVmid)}/clone`, {
      method: 'POST',
      body: {
        newid: vm.vmid,
        name: `lfpool-${vm.vmid}`,
        full: 0, // linked clone (P0 requirement)
        target: vm.node,
        pool: settings.proxmox_pool || undefined,
        description: `${ownershipMarker(vm.id)}\nLabFactory Windows pool, template ${template.sourceTemplateVmid} revision ${vm.revision}`
      }
    });
    let current = await saveCheckpoint(vm, { cloneUpid: upid });
    if (cloneLease) await attachProxmoxTask(db, cloneLease, upid);
    await proxmox.waitTask(upid, { timeoutMs: opts.cloneTimeoutMs });
    current = await saveCheckpoint(current, { cloned: true, node: vm.node, attempts: 0 });
    return current;
  }

  // Configuration before the first boot: every NIC disconnected, provisional cloud-init
  // metadata (configdrive2 + DHCP + account/password) to avoid the P0 Cloudbase-Init error.
  async function configureVm(vm, template) {
    const node = vm.checkpoint.node ?? vm.node;
    const config = await proxmox.getConfig(node, vm.vmid);
    if (!isOurs(config, vm.id)) {
      return transition(vm, 'deleting', { detail: { code: 'VMID_FOREIGN' }, patch: { error_code: 'VMID_FOREIGN' } });
    }
    const nets = netKeys(config);
    if (!nets.length) return quarantine(vm, 'NO_NIC', 'Template without a network card');
    const patch = {
      onboot: 0,
      citype: 'configdrive2',
      ciuser: adminUsernameFor(template.language),
      cipassword: provisionalPassword(),
      ipconfig0: 'ip=dhcp',
      tags: 'labfactory-pool',
      digest: config.digest
    };
    for (const key of nets) patch[key] = withLinkDown(config[key]);
    await proxmox.setConfig(node, vm.vmid, patch);
    const check = await proxmox.getConfig(node, vm.vmid);
    if (!netKeys(check).every(key => /link_down=1/.test(check[key])) || check.citype !== 'configdrive2') {
      return quarantine(vm, 'ISOLATION_FAILED', 'NIC disconnection not confirmed before the first boot');
    }
    return saveCheckpoint(vm, { configured: true, attempts: 0 }, {}).then(row =>
      db.query('UPDATE windows_pool_vms SET mac = $2, node = $3 WHERE id = $1 RETURNING *', [row.id, macOf(check.net0), node]).then(r => r.rows[0]));
  }

  // Global preparation budget (category 'prepare'): counted from the 'preparing' VMs in
  // the database, so it is crash-proof. Short transaction serialized by an advisory lock.
  async function enterPreparation(vm) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(1279346248, hashtext('prepare|cluster'))`);
      const limit = (await client.query(`SELECT max_active FROM windows_pool_operation_limits WHERE category = 'prepare' AND scope = 'cluster'`)).rows[0];
      const active = (await client.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'preparing'`)).rows[0].n;
      if (limit && active >= limit.max_active) { await client.query('ROLLBACK'); return null; }
      const next = await transitionPoolVm(client, {
        id: vm.id, from: 'creating', to: 'preparing', version: vm.version,
        patch: { checkpoint: { ...vm.checkpoint, preparingSince: now(), nextProbeAt: now() + opts.firstProbeDelayMs, attempts: 0 } }
      });
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async function advanceCreating(vm, { cloneLease = null } = {}) {
    const template = await loadTemplate(vm.template_id);
    const settings = await loadSettings();
    let current = vm;
    try {
      if (!current.checkpoint.cloned) {
        if (current.checkpoint.cloneUpid) {
          // Resume after a crash: wait for the existing task, never re-clone blindly.
          await proxmox.waitTask(current.checkpoint.cloneUpid, { timeoutMs: opts.cloneTimeoutMs });
          current = await saveCheckpoint(current, { cloned: true, node: current.node });
        } else {
          let lease = cloneLease;
          if (!lease) {
            lease = await tryAcquireLease(db, { category: 'clone', scopes: leaseScopes({ node: current.node, storage: template.storage }), holder, poolVmId: current.id, ttlSeconds: opts.cloneLeaseSeconds });
            if (!lease) return current; // ceiling reached: next tick
          }
          try { current = await cloneVm(current, template, settings, lease); } finally { if (!cloneLease) await releaseLease(db, lease); }
          if (current.state !== 'creating') return current;
        }
      }
      if (!current.checkpoint.configured) {
        current = await configureVm(current, template);
        if (current.state !== 'creating') return current;
      }
      return (await enterPreparation(current)) ?? current;
    } catch (error) {
      if (error.code === 'POOL_VM_STALE') throw error;
      if (/already exists/i.test(error.message)) {
        return transition(current, 'deleting', { detail: { code: 'VMID_COLLISION' }, patch: { error_code: 'VMID_COLLISION', last_error: error.message } });
      }
      // Clone task finished in failure: forget its UPID so that a retry is allowed
      // (the VMID will be re-checked, including an orphan disk left by the failure).
      if (error.code === 'TASK_FAILED' && !current.checkpoint.cloned) {
        current = await saveCheckpoint(current, { cloneUpid: null });
      }
      // Infrastructure unavailable (storage, cfs-lock...): wait without counting a VM failure.
      if (error.code === 'VOLUME_CHECK_UNAVAILABLE' || (isTransientProxmoxError(error) && error.code !== 'TASK_FAILED')) {
        return saveCheckpoint(current, { nextAttemptAt: now() + opts.retryBackoffMs[1] }, { lastError: String(error.message).slice(0, 1000) });
      }
      return retryLater(current, error);
    }
  }

  // ------------------------------------------------------- automatic placement

  // Memory (bytes) of the source template, per VMID: penalty applied to a node for each
  // VM of the pool still in creation/preparation there (not yet visible in its `mem`).
  const templateMemory = new Map();
  const memoryOf = async template => {
    if (!templateMemory.has(template.sourceTemplateVmid)) {
      let bytes = opts.defaultVmMemoryBytes ?? 4 * 1024 ** 3;
      try {
        const source = await proxmox.findGuest(template.sourceTemplateVmid);
        const config = source ? await proxmox.getConfig(source.node, template.sourceTemplateVmid) : null;
        if (Number(config?.memory) > 0) bytes = Number(config.memory) * 1024 ** 2;
      } catch { /* default value */ }
      templateMemory.set(template.sourceTemplateVmid, bytes);
    }
    return templateMemory.get(template.sourceTemplateVmid);
  };
  const choosing = new Map(); // node -> placements chosen in this process, not yet allocated

  // Node of a new VM: the template one when set (forced); otherwise the online node that sees
  // the template storage with the most free memory, minus the in-flight preparations.
  // The HA activated at ready then lets Proxmox move the VMs.
  async function chooseNode(template) {
    if (template.node) return template.node;
    const [nodes, storages] = await Promise.all([
      proxmox.request('cluster/resources?type=node'),
      proxmox.request('cluster/resources?type=storage')
    ]);
    const withStorage = new Set((storages ?? [])
      .filter(s => s.storage === template.storage && (s.status ?? 'available') === 'available')
      .map(s => s.node));
    const candidates = (nodes ?? []).filter(n => n.status === 'online' && withStorage.has(n.node) && Number(n.maxmem) > 0);
    if (!candidates.length) {
      throw Object.assign(new Error(`No online node sees storage ${template.storage}`), { code: 'NO_PLACEMENT_NODE' });
    }
    const inFlight = new Map((await db.query(
      `SELECT node, COUNT(*)::int AS n FROM windows_pool_vms WHERE state IN ('creating', 'preparing') GROUP BY node`)).rows
      .map(row => [row.node, row.n]));
    const memory = await memoryOf(template);
    // 1. fewest preparations in progress (a Windows first boot weighs on CPU/disk much more than
    //    on memory: with the memory alone, 21 of 22 clones went to the node with the most free
    //    memory in dev, 58% CPU there vs 6-17% elsewhere);
    // 2. then the most free memory (minus the VMs not yet started), only on nodes that keep a
    //    margin after this VM.
    const pending = n => (inFlight.get(n.node) ?? 0) + (choosing.get(n.node) ?? 0);
    const free = n => Number(n.maxmem) - Number(n.mem ?? 0) - pending(n) * memory;
    const roomy = candidates.filter(n => free(n) - memory >= Number(n.maxmem) * (opts.placementMemoryMarginRatio ?? 0.1));
    if (!roomy.length) {
      throw Object.assign(new Error(`No node keeps a memory margin for a new ${template.sourceTemplateVmid} VM`), { code: 'NO_PLACEMENT_NODE' });
    }
    return roomy.sort((a, b) => pending(a) - pending(b) || free(b) - free(a) || String(a.node).localeCompare(String(b.node)))[0].node;
  }

  // Choices serialized in this process: creations launched in the same tick see each other.
  let placementQueue = Promise.resolve();
  const placeNode = template => {
    const result = placementQueue.then(async () => {
      const node = await chooseNode(template);
      choosing.set(node, (choosing.get(node) ?? 0) + 1);
      return node;
    });
    placementQueue = result.catch(() => undefined);
    return result;
  };

  async function createOne(template, onAllocated = () => {}) {
    let node;
    try {
      node = await placeNode(template);
    } catch (error) {
      log.warn?.(`[windows-pool] placement of a ${template.sourceTemplateVmid} VM impossible: ${error.message}`);
      return null;
    }
    let chosen = true;
    const unchoose = () => {
      if (!chosen) return;
      chosen = false;
      choosing.set(node, Math.max(0, (choosing.get(node) ?? 1) - 1));
    };
    try {
      const placed = { ...template, node };
      const lease = await tryAcquireLease(db, { category: 'clone', scopes: leaseScopes(placed), holder, ttlSeconds: opts.cloneLeaseSeconds });
      if (!lease) return null;
      try {
        let vm;
        try {
          vm = await allocatePoolVm(db, { templateConfig: placed, checkFreeVmid: vmidCheckFor(placed) });
        } catch (error) {
          if (error.code === 'VOLUME_CHECK_UNAVAILABLE') { log.warn?.(`[windows-pool] ${error.message}; allocation postponed`); return null; }
          throw error;
        }
        unchoose(); // the 'creating' row now counts in the in-flight preparations of the node
        onAllocated(); // from now on the 'creating' row counts in the stock
        return await withVmLock(vm.id, async () => advanceCreating(await loadVm(vm.id), { cloneLease: lease }));
      } finally {
        await releaseLease(db, lease);
      }
    } finally {
      unchoose();
    }
  }

  // ------------------------------------------------------------- preparation

  async function advancePreparing(vm) {
    const template = await loadTemplate(vm.template_id);
    const node = vm.node;
    const since = Number(vm.checkpoint?.preparingSince ?? now());
    if (now() - since > template.preparationTimeoutSeconds * 1000) {
      return quarantine(vm, 'PREPARATION_TIMEOUT', `Preparation longer than ${template.preparationTimeoutSeconds}s`);
    }
    try {
      // Network isolation re-checked on every pass: no network access before assignment.
      const config = await proxmox.getConfig(node, vm.vmid);
      if (!isOurs(config, vm.id)) return quarantine(vm, 'OWNERSHIP_LOST', 'Ownership marker missing');
      if (!netKeys(config).every(key => /link_down=1/.test(config[key]))) return quarantine(vm, 'NIC_CONNECTED', 'NIC connected during preparation');

      const power = await proxmox.status(node, vm.vmid);
      if (power?.status !== 'running') {
        if (vm.checkpoint?.started) return quarantine(vm, 'VM_STOPPED', 'VM stopped during preparation');
        await proxmox.waitTask(await proxmox.request(`${proxmox.vmPath(node, vm.vmid)}/status/start`, { method: 'POST' }), { timeoutMs: opts.powerTimeoutMs });
        return saveCheckpoint(vm, { started: true, startedAt: now(), nextProbeAt: now() + opts.firstProbeDelayMs });
      }
      if (!vm.checkpoint?.started) vm = await saveCheckpoint(vm, { started: true, startedAt: now() });

      const lease = await tryAcquireLease(db, { category: 'guest_probe', holder, poolVmId: vm.id, ttlSeconds: opts.probeLeaseSeconds });
      if (!lease) return saveCheckpoint(vm, { nextProbeAt: now() + 2_000 });
      let verdict;
      try {
        let probe = null;
        try {
          probe = parseJsonOutput(await proxmox.guestRun(node, vm.vmid, READINESS_PROBE_SCRIPT));
        } catch (error) {
          if (!isAgentUnavailable(error) && error.code !== 'GUEST_TIMEOUT') throw error;
        }
        verdict = evaluateReadiness(probe, { poolVmId: vm.id, revision: vm.revision });
        if (verdict.code === 'MARKER_MISSING') {
          parseJsonOutput(await proxmox.guestRun(node, vm.vmid, buildReadyMarkerScript({ poolVmId: vm.id, revision: vm.revision })));
          return saveCheckpoint(vm, { nextProbeAt: now(), lastCode: 'MARKER_WRITTEN' });
        }
      } finally {
        await releaseLease(db, lease);
      }
      if (verdict.fatal) return quarantine(vm, verdict.code, verdict.detail);
      if (verdict.ready) {
        // The provisional password must not stay in the Proxmox configuration.
        await proxmox.setConfig(node, vm.vmid, { delete: 'cipassword' });
        // HA from ready on (user decision 2026-11-20): Proxmox restarts/relocates the VM if its
        // node fails. A failure = retry on the next probe (the VM stays 'preparing').
        await proxmox.ensureHaStarted?.(vm.vmid);
        const ready = await transition(vm, 'ready', { detail: { preparationMs: now() - since } });
        await db.query(`SELECT pg_notify('${STOCK_NOTIFY_CHANNEL}', $1)`, [vm.template_id]);
        return ready;
      }
      return saveCheckpoint(vm, { nextProbeAt: now() + opts.probeIntervalMs, lastCode: verdict.code });
    } catch (error) {
      if (error.code === 'POOL_VM_STALE') throw error;
      if (isTransientProxmoxError(error) || isAgentUnavailable(error)) return saveCheckpoint(vm, { nextProbeAt: now() + opts.probeIntervalMs });
      return retryLater(vm, error);
    }
  }

  // ------------------------------------------------------------- destruction

  async function advanceDeleting(vm) {
    try {
      const guest = await proxmox.findGuest(vm.vmid);
      if (!guest) return transition(vm, 'deleted', { detail: { code: 'ABSENT' } });
      const config = await proxmox.getConfig(guest.node, vm.vmid).catch(error => (isMissingVm(error) ? null : Promise.reject(error)));
      if (!config) return transition(vm, 'deleted', { detail: { code: 'ABSENT' } });
      if (!isOurs(config, vm.id)) {
        // Foreign VM on this VMID: release the row WITHOUT touching Proxmox.
        log.warn?.(`[windows-pool] VMID ${vm.vmid} belongs to another VM: no destruction`);
        return transition(vm, 'deleted', { detail: { code: 'VMID_FOREIGN' }, patch: { error_code: vm.error_code ?? 'VMID_FOREIGN' } });
      }
      if (config.lock) return saveCheckpoint(vm, { nextAttemptAt: now() + 15_000 }, { lastError: `Proxmox lock ${config.lock}` });
      const lease = await tryAcquireLease(db, { category: 'destroy', scopes: leaseScopes({ node: guest.node }), holder, poolVmId: vm.id, ttlSeconds: 300 });
      if (!lease) return vm;
      try {
        // HA first: otherwise Proxmox restarts (or recovers) the VM during the destruction.
        await proxmox.removeHa?.(vm.vmid);
        const power = await proxmox.status(guest.node, vm.vmid);
        if (power?.status === 'running') {
          const stop = await proxmox.request(`${proxmox.vmPath(guest.node, vm.vmid)}/status/stop`, { method: 'POST' });
          await attachProxmoxTask(db, lease, stop);
          await proxmox.waitTask(stop, { timeoutMs: opts.powerTimeoutMs });
        }
        const destroy = await proxmox.request(`${proxmox.vmPath(guest.node, vm.vmid)}?purge=1&destroy-unreferenced-disks=1`, { method: 'DELETE' });
        await attachProxmoxTask(db, lease, destroy);
        await proxmox.waitTask(destroy, { timeoutMs: opts.cloneTimeoutMs });
      } finally {
        await releaseLease(db, lease);
      }
      return transition(vm, 'deleted', { detail: { code: 'DESTROYED' } });
    } catch (error) {
      if (error.code === 'POOL_VM_STALE') throw error;
      return retryLater(vm, error);
    }
  }

  // --------------------------------------------------------------------- tick

  async function advance(id) {
    return withVmLock(id, async () => {
      const vm = await loadVm(id);
      if (!vm) return vm;
      // Template disabled: in-flight preparations are abandoned (useless to finish a
      // preparation to destroy it right after). Under the per-VM lock: never a clone started
      // after this decision; a clone already in progress is waited for (never interrupted) then destroyed
      // by advanceDeleting after checking the ownership marker.
      if (['creating', 'preparing'].includes(vm.state)) {
        const template = (await db.query('SELECT enabled FROM windows_pool_templates WHERE template_id = $1', [vm.template_id])).rows[0];
        if (template && !template.enabled) {
          return transition(vm, 'deleting', { detail: { code: 'TEMPLATE_DISABLED' }, patch: { error_code: 'TEMPLATE_DISABLED' } });
        }
      }
      if (!isDue(vm)) return vm;
      if (vm.state === 'creating') return advanceCreating(vm);
      if (vm.state === 'preparing') return isDue(vm, 'nextProbeAt') ? advancePreparing(vm) : vm;
      if (vm.state === 'deleting') return advanceDeleting(vm);
      return vm;
    });
  }

  async function tick() {
    await reconcileOrphanLeases(db, proxmox.taskState).catch(error => log.warn?.(`[windows-pool] lease reconciliation: ${error.message}`));
    const settings = await loadSettings();
    // Drain the old revisions: a new revision = a new template (linked clones).
    await db.query(
      `WITH updated AS (
         UPDATE windows_pool_vms v SET state = 'deleting', version = v.version + 1, state_changed_at = NOW(), error_code = 'REVISION_DRAINED'
           FROM windows_pool_templates t
          WHERE v.template_id = t.template_id AND v.state = 'ready' AND v.revision <> t.revision
          RETURNING v.id)
       INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
       SELECT id, 'ready', 'deleting', '{"code":"REVISION_DRAINED"}'::jsonb FROM updated`);

    // Stock surplus (user decision 2026-11-20): disabled template -> its ready VMs are destroyed;
    // reserve lowered -> only the ready VMs beyond (reserve + demand of the waiting labs). The most
    // recent ones are kept. Never touched: reserved/assigned VMs (labs) and in-flight preparations
    // (handled once ready). SKIP LOCKED: never a VM being reserved by a lab. The global
    // suspension (paused) does not trigger any destruction: it keeps the stock.
    await db.query(
      `WITH demand AS (${DEMAND_SQL}),
       keep AS (
         SELECT t.template_id, t.revision,
                CASE WHEN t.enabled THEN t.ready_target + COALESCE(dm.n, 0) ELSE 0 END AS keep
           FROM windows_pool_templates t LEFT JOIN demand dm ON dm.template_id = t.template_id),
       ranked AS (
         SELECT v.id, k.keep, row_number() OVER (PARTITION BY v.template_id ORDER BY v.ready_at DESC NULLS LAST, v.id) AS rank
           FROM windows_pool_vms v JOIN keep k ON k.template_id = v.template_id AND k.revision = v.revision
          WHERE v.state = 'ready'),
       victims AS (
         SELECT v.id FROM windows_pool_vms v JOIN ranked r ON r.id = v.id
          WHERE r.rank > r.keep FOR UPDATE OF v SKIP LOCKED),
       updated AS (
         UPDATE windows_pool_vms v SET state = 'deleting', version = v.version + 1, state_changed_at = NOW(), error_code = 'STOCK_SURPLUS'
           FROM victims x WHERE v.id = x.id AND v.state = 'ready' RETURNING v.id)
       INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
       SELECT id, 'ready', 'deleting', '{"code":"STOCK_SURPLUS"}'::jsonb FROM updated`);

    const active = (await db.query(`SELECT id FROM windows_pool_vms WHERE state IN ('creating', 'preparing', 'deleting') ORDER BY state_changed_at`)).rows;
    for (const { id } of active) launch(`vm:${id}`, () => advance(id));

    const templates = (await db.query(
      `SELECT p.*, t.language FROM windows_pool_templates p JOIN vm_templates t ON t.id = p.template_id WHERE p.enabled`)).rows
      .map(row => ({ ...mapTemplatePoolRow(row), language: row.language }));
    const counts = new Map();
    for (const row of (await db.query(`SELECT template_id, state, COUNT(*)::int AS n FROM windows_pool_vms
                                        WHERE state IN ('creating','preparing','ready') AND revision = (
                                          SELECT revision FROM windows_pool_templates t WHERE t.template_id = windows_pool_vms.template_id)
                                        GROUP BY 1, 2`)).rows) {
      counts.set(row.template_id, { ...(counts.get(row.template_id) ?? {}), [row.state]: row.n });
    }
    const demand = new Map((await db.query(DEMAND_SQL)).rows.map(row => [row.template_id, row.n]));
    // Labs in progress (deployment, customization, start/stop, destruction): the reserve waits.
    // 'waiting_for_pool' excluded: these labs need the pool (their demand is always served).
    const busyLabs = await countBusyLabs();
    // Global ceiling (migration 036): stock of ALL the templates (any revision) + creations
    // launched but not yet allocated, shared by the templates in this tick.
    const maxCapacity = Number(settings?.max_capacity ?? 50);
    let totalStock = (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state IN ('creating', 'preparing', 'ready')`)).rows[0].n
      + [...pendingCreations.values()].reduce((sum, n) => sum + n, 0);
    const plans = [];
    for (const template of templates) {
      const c = { ...(counts.get(template.templateId) ?? {}) };
      c.creating = (c.creating ?? 0) + (pendingCreations.get(template.templateId) ?? 0);
      const own = (c.creating ?? 0) + (c.preparing ?? 0) + (c.ready ?? 0);
      const plan = planReplenishment({ config: template, counts: c, waitingDemand: demand.get(template.templateId) ?? 0, paused: settings?.paused,
        holdReserve: busyLabs > 0, maxCapacity, otherStock: Math.max(0, totalStock - own) });
      totalStock += plan.toStart;
      plans.push({ templateId: template.templateId, ...plan });
      for (let i = 0; i < plan.toStart; i += 1) {
        pendingCreations.set(template.templateId, (pendingCreations.get(template.templateId) ?? 0) + 1);
        let counted = true;
        const uncount = () => {
          if (!counted) return;
          counted = false;
          pendingCreations.set(template.templateId, Math.max(0, (pendingCreations.get(template.templateId) ?? 1) - 1));
        };
        launch(`create:${template.templateId}:${randomBytes(4).toString('hex')}`, async () => {
          try { await createOne(template, uncount); } finally { uncount(); }
        });
      }
    }
    return { plans, inflight: inflight.size, busyLabs };
  }

  async function countBusyLabs() {
    try {
      return (await db.query(
        `SELECT COUNT(*)::int AS n FROM lab_deployments
          WHERE status = ANY($1::text[]) AND updated_at > NOW() - make_interval(secs => $2)`,
        [BUSY_LAB_STATUSES, opts.labActivityMaxAgeMs / 1000])).rows[0].n;
    } catch (error) {
      // Table/column absent (isolated tests): no hold rather than no pool.
      if (['42P01', '42703'].includes(error?.code)) return 0;
      throw error;
    }
  }

  // Waits for the operations launched by the previous ticks (tests, clean shutdown).
  const drain = async () => { while (inflight.size) await Promise.allSettled([...inflight.values()]); };

  return { tick, drain, advance, inflightCount: () => inflight.size };
}
