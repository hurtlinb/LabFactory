// Windows pool manager (P2): real PostgreSQL (isolated schema) + simulated Proxmox.
// Enabled by WINDOWS_POOL_TEST_DATABASE_URL (see tests/windowsPool.db.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPoolProxmox, ProxmoxError } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;


const quiet = { error() {}, warn() {}, info() {} };
const fast = { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 };

async function until(manager, predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await manager.tick();
    await sleep(10);
    if (await predicate()) { await manager.drain(); return; }
    if (Date.now() > deadline) { await manager.drain(); throw new Error('Condition not reached in time'); }
  }
}

test('Windows pool manager (P2)', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_mgr_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 30 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT);
                    CREATE TABLE lab_deployments (id UUID PRIMARY KEY);`);
    await db.query(await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8'));
    await db.query(`UPDATE windows_pool_settings SET paused = false, proxmox_pool = 'labs-test'`);
    await db.query(`UPDATE windows_pool_operation_limits SET max_active = 2 WHERE category = 'clone'`);
    const templateId = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'fr')`, [templateId]);
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                    VALUES ($1, true, 4, 6, 4, 'pve-b', 'ceph-pool', 147)`, [templateId]);
    const states = async () => Object.fromEntries((await db.query(`SELECT state, COUNT(*)::int AS n FROM windows_pool_vms GROUP BY 1`)).rows.map(r => [r.state, r.n]));

    const px = fakeProxmox();
    px.hidden.add(70000); // VMID taken by an invisible guest: must be skipped
    px.volumes.push({ volid: 'ceph-pool:vm-70001-disk-0' }); // orphan disk: must be skipped
    const manager = createPoolManager({ db, proxmox: createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'test-1', log: quiet, options: fast });

    await t.test('replenishment: linked clones isolated before boot, parallel within the ceilings', async () => {
      await until(manager, async () => (await states()).ready === 4);
      const vms = (await db.query(`SELECT * FROM windows_pool_vms WHERE state = 'ready' ORDER BY vmid`)).rows;
      assert.ok(vms.every(vm => vm.vmid >= 70002), 'hidden VMID and orphan disk skipped');
      assert.equal(new Set(vms.map(vm => vm.vmid)).size, 4);
      for (const call of px.stats.cloneCalls) {
        assert.equal(Number(call.full), 0, 'linked clone');
        assert.equal(call.target, 'pve-b');
        assert.equal(call.pool, 'labs-test');
        assert.match(call.description, /labfactory-pool:[0-9a-f-]{36}/);
      }
      assert.equal(px.stats.maxActiveClones, 2, 'clone ceiling (2) reached but never exceeded');
      assert.ok(px.stats.maxPreparing >= 2, `concurrent preparations (max ${px.stats.maxPreparing})`);
      for (const vm of vms) {
        const g = px.guests.get(vm.vmid);
        const atStart = g.history.find(h => h.at === 'start').config;
        assert.match(atStart.net0, /link_down=1/, 'NIC disconnected at the first boot');
        assert.equal(atStart.citype, 'configdrive2');
        assert.equal(atStart.ipconfig0, 'ip=dhcp');
        assert.equal(atStart.ciuser, 'Administrateur', 'French template');
        assert.ok(atStart.cipassword, 'provisional password provided before boot');
        assert.equal(g.config.cipassword, undefined, 'provisional password removed once ready');
        assert.equal(g.config.onboot, 0);
        assert.deepEqual(g.marker, { poolVmId: vm.id, revision: 1 });
        assert.equal(vm.mac, 'AA:AA:AA:AA:AA:AA');
      }
      const events = (await db.query(`SELECT to_state FROM windows_pool_vm_events WHERE pool_vm_id = $1 ORDER BY id`, [vms[0].id])).rows.map(r => r.to_state);
      assert.deepEqual(events, ['creating', 'preparing', 'ready']);
      const leases = (await db.query('SELECT COUNT(*)::int AS n FROM windows_pool_operation_leases')).rows[0].n;
      assert.equal(leases, 0, 'every lease released');
      // Stable: no extra creation once the reserve is reached.
      const before = px.stats.clones;
      await manager.tick(); await manager.drain();
      assert.equal(px.stats.clones, before);
    });

    await t.test('demand above the reserve: preparations up to the ceiling', async () => {
      const deploymentId = randomUUID();
      await db.query('INSERT INTO lab_deployments VALUES ($1)', [deploymentId]);
      await db.query(`INSERT INTO windows_pool_requests (id, deployment_id, kind, demand) VALUES ($1, $2, 'deploy', $3)`,
        [randomUUID(), deploymentId, JSON.stringify([{ templateId, count: 5 }])]);
      await until(manager, async () => (await states()).ready === 6);
      await db.query(`UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW()`);
    });

    await t.test('fatal bootstrap and connected NIC: quarantine, never ready', async () => {
      await db.query(`UPDATE windows_pool_templates SET ready_target = 0, max_capacity = 8`);
      const deploymentId = randomUUID();
      await db.query('INSERT INTO lab_deployments VALUES ($1)', [deploymentId]);
      await db.query(`INSERT INTO windows_pool_requests (id, deployment_id, kind, demand) VALUES ($1, $2, 'deploy', $3)`,
        [randomUUID(), deploymentId, JSON.stringify([{ templateId, count: 8 }])]);
      const known = new Set(px.guests.keys());
      // Sabotage the next 2 VMs as soon as they appear.
      const saboteur = setInterval(() => {
        const fresh = [...px.guests.keys()].filter(id => !known.has(id));
        if (fresh[0] && !px.guests.get(fresh[0]).probeOverride) px.guests.get(fresh[0]).probeOverride = { errorCount: 2 };
        if (fresh[1] && px.guests.get(fresh[1]).bootAt && !px.guests.get(fresh[1]).sabotaged) {
          px.guests.get(fresh[1]).sabotaged = true;
          px.guests.get(fresh[1]).config.net0 = px.guests.get(fresh[1]).config.net0.replace('link_down=1', 'link_down=0');
        }
      }, 2);
      try {
        await until(manager, async () => (await states()).quarantined === 2);
      } finally { clearInterval(saboteur); }
      const codes = (await db.query(`SELECT error_code FROM windows_pool_vms WHERE state = 'quarantined' ORDER BY error_code`)).rows.map(r => r.error_code);
      assert.deepEqual(codes, ['BOOTSTRAP_ERRORS', 'NIC_CONNECTED']);
      await db.query(`UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW() WHERE status = 'waiting_for_pool'`);
      await manager.drain();
    });

    await t.test('destruction: a foreign VM on the same VMID is never touched', async () => {
      const foreignVmid = 70500;
      px.guests.set(foreignVmid, { node: 'pve-a', status: 'running', history: [], config: { name: 'other-lab', description: 'Lab of another team', net0: 'virtio=BB:BB:BB:BB:BB:BB' } });
      const id = randomUUID();
      await db.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state)
                      VALUES ($1, $2, 1, 147, 'default', 'pve-a', $3, 'deleting')`, [id, templateId, foreignVmid]);
      await until(manager, async () => (await db.query('SELECT state FROM windows_pool_vms WHERE id = $1', [id])).rows[0].state === 'deleted');
      assert.ok(px.guests.has(foreignVmid), 'foreign VM kept');
      assert.equal(px.guests.get(foreignVmid).status, 'running');
      assert.ok(!px.log.some(line => line.includes(`/qemu/${foreignVmid}?purge`) || line.includes(`/qemu/${foreignVmid}/status/stop`)));
    });

    await t.test('crash during a clone: resume on the same task, no second clone', async () => {
      await db.query(`UPDATE windows_pool_templates SET ready_target = 0`);
      const id = randomUUID();
      const vmid = 70600;
      // State left by a worker killed right after the POST clone.
      px.guests.set(vmid, { node: 'pve-b', status: 'stopped', lock: 'clone', history: [],
        config: { name: `lfpool-${vmid}`, description: `labfactory-pool:${id}`, net0: 'virtio=CC:CC:CC:CC:CC:CC,bridge=vmbr0', digest: 'x' } });
      const upid = px.task('pve-b', 'qmclone', vmid, 80, () => { delete px.guests.get(vmid).lock; });
      await db.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state, checkpoint)
                      VALUES ($1, $2, 1, 147, 'default', 'pve-b', $3, 'creating', $4)`, [id, templateId, vmid, JSON.stringify({ cloneUpid: upid })]);
      const clonesBefore = px.stats.clones;
      const restarted = createPoolManager({ db, proxmox: createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'test-2', log: quiet, options: fast });
      await until(restarted, async () => (await db.query('SELECT state FROM windows_pool_vms WHERE id = $1', [id])).rows[0].state === 'ready');
      assert.equal(px.stats.clones, clonesBefore, 'no new clone');
      assert.match(px.guests.get(vmid).history.find(h => h.at === 'start').config.net0, /link_down=1/);
    });

    await t.test('new revision: old ready VMs drained and destroyed, replaced', async () => {
      await db.query(`UPDATE windows_pool_templates SET ready_target = 2, max_capacity = 4, revision = 2`);
      const oldReady = (await db.query(`SELECT vmid FROM windows_pool_vms WHERE state = 'ready'`)).rows.map(r => r.vmid);
      await until(manager, async () => {
        const rows = (await db.query(`SELECT revision, state FROM windows_pool_vms WHERE state IN ('ready','deleting','creating','preparing')`)).rows;
        return rows.filter(r => r.revision === 2 && r.state === 'ready').length === 2 && !rows.some(r => r.revision === 1);
      }, { timeoutMs: 20_000 });
      assert.ok(oldReady.every(vmid => !px.guests.has(vmid)), 'old revision destroyed on the Proxmox side');
    });

    await t.test('storage unavailable: allocation postponed without quarantine, then resumed', async () => {
      const down = fakeProxmox();
      down.stats.storageDown = true;
      await db.query(`UPDATE windows_pool_templates SET ready_target = 3, max_capacity = 5`);
      const m = createPoolManager({ db, proxmox: createPoolProxmox(down.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'test-5', log: quiet,
        options: fast });
      const before = (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms`)).rows[0].n;
      for (let i = 0; i < 5; i++) { await m.tick(); await m.drain(); }
      assert.equal(down.stats.clones, 0, 'never clone without a complete check');
      assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms`)).rows[0].n, before, 'no VMID burnt or allocated');
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM windows_pool_operation_leases')).rows[0].n, 0);
      down.stats.storageDown = false;
      await until(m, async () => down.stats.clones >= 1);
      await db.query(`UPDATE windows_pool_templates SET ready_target = 0`);
    });

    await t.test('preparation timeout: quarantine', async () => {
      const slow = fakeProxmox({ prepMs: 60_000 });
      await db.query(`UPDATE windows_pool_templates SET ready_target = 3, max_capacity = 8, preparation_timeout_seconds = 300`);
      // Simulated clock: +301 s once the VM is preparing.
      let offset = 0;
      const clocked = createPoolManager({ db, proxmox: createPoolProxmox(slow.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'test-4', log: quiet,
        options: fast, now: () => Date.now() + offset });
      await until(clocked, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'preparing'`)).rows[0].n >= 1);
      offset = 301_000;
      await until(clocked, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE error_code = 'PREPARATION_TIMEOUT'`)).rows[0].n >= 1);
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
