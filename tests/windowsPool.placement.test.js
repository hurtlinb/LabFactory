// Windows pool: automatic placement (template without a node) + HA activated at ready (2026-11-20).
// Real PostgreSQL (isolated schema) + simulated Proxmox. Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { templatePoolConfigSchema } from '../lib/windowsPool/config.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {} };
const fast = { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 };
const GiB = 1024 ** 3;

async function until(manager, predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await manager.tick();
    await sleep(10);
    if (await predicate()) { await manager.drain(); return; }
    if (Date.now() > deadline) { await manager.drain(); throw new Error('Condition not reached in time'); }
  }
}

test('template config: node optional, storage required to enable', () => {
  const base = { templateId: randomUUID(), enabled: true, readyTarget: 1, maxCapacity: 2, maxParallelPreparations: 1, revision: 1,
    sourceTemplateVmid: 147, cloneMode: 'linked', preparationTimeoutSeconds: 1800, assignmentTimeoutSeconds: 600 };
  assert.ok(templatePoolConfigSchema.safeParse({ ...base, node: null, storage: 'ceph-pool' }).success);
  assert.equal(templatePoolConfigSchema.safeParse({ ...base, node: 'pve-a', storage: null }).success, false);
});

test('Windows pool: automatic placement and HA', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_place_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 20 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT);
                    CREATE TABLE lab_deployments (id UUID PRIMARY KEY);`);
    for (const file of ['032-windows-pool.sql', '034-windows-pool-auto-placement.sql', '034-windows-pool-auto-placement.sql', '035-windows-pool-replacements.sql', '036-windows-pool-simplified-activation.sql']) {
      await db.query(await fs.readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8')); // 034 replayed: idempotent
    }
    await db.query(`UPDATE windows_pool_settings SET paused = false, proxmox_pool = 'pool-test'`);
    const templateId = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [templateId]);

    await t.test('034: an enabled template without a node is accepted, without a storage refused', async () => {
      await assert.rejects(db.query(
        `INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
         VALUES ($1, true, 2, 4, 2, 'pve-a', NULL, 147)`, [templateId]), /enabled_placement/);
      await db.query(
        `INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
         VALUES ($1, true, 2, 4, 2, NULL, 'ceph-pool', 147)`, [templateId]);
    });

    // pve-b: 60 GiB free, pve-a: 40 GiB, pve-e: 4 GiB (below the 10% margin), pve-c: offline,
    // pve-d: does not see ceph-pool. VM of 4 GiB: 1st on pve-b (most free memory), 2nd on pve-a
    // (fewer preparations in progress) although pve-b still has more free memory: spread first
    // (dev 2026-11-20: 21 of 22 clones on the node with the most free memory).
    const px = fakeProxmox({
      nodes: [
        { node: 'pve-a', status: 'online', mem: 24 * GiB, maxmem: 64 * GiB },
        { node: 'pve-b', status: 'online', mem: 4 * GiB, maxmem: 64 * GiB },
        { node: 'pve-c', status: 'offline', mem: 0, maxmem: 64 * GiB },
        { node: 'pve-d', status: 'online', mem: 0, maxmem: 512 * GiB },
        { node: 'pve-e', status: 'online', mem: 60 * GiB, maxmem: 64 * GiB }
      ],
      storages: { 'ceph-pool': ['pve-a', 'pve-b', 'pve-c', 'pve-e'], 'local-lvm': ['pve-d'] }
    });
    px.guests.get(147).config.memory = 4096;
    const manager = createPoolManager({ db, proxmox: createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'test-place', log: quiet, options: fast });

    await t.test('placement: preparations spread first, then free memory; node without margin excluded', async () => {
      await until(manager, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'ready'`)).rows[0].n === 2);
      const targets = px.stats.cloneCalls.map(call => call.target).sort();
      assert.deepEqual(targets, ['pve-a', 'pve-b']);
      const vms = (await db.query(`SELECT vmid, node FROM windows_pool_vms WHERE state = 'ready'`)).rows;
      for (const vm of vms) assert.equal(px.guests.get(vm.vmid).node, vm.node, 'node recorded = clone target');
    });

    await t.test('HA started once ready', async () => {
      const vms = (await db.query(`SELECT id, vmid FROM windows_pool_vms WHERE state = 'ready'`)).rows;
      for (const vm of vms) {
        assert.equal(px.ha.get(`vm:${vm.vmid}`), 'started');
        const add = px.stats.events.find(e => e.vmid === vm.vmid && e.at === 'ha-add');
        assert.ok(add, 'HA resource created');
        const events = (await db.query(`SELECT to_state FROM windows_pool_vm_events WHERE pool_vm_id = $1 ORDER BY id`, [vm.id])).rows.map(r => r.to_state);
        assert.deepEqual(events, ['creating', 'preparing', 'ready']);
      }
    });

    await t.test('destruction: HA removed before the stop', async () => {
      const vmids = (await db.query(`SELECT vmid FROM windows_pool_vms WHERE state = 'ready' ORDER BY vmid`)).rows.map(r => r.vmid);
      // VM without HA (ready before the HA version, lab 187 in dev): "not HA managed" tolerated.
      px.ha.delete(`vm:${vmids[0]}`);
      await db.query(`UPDATE windows_pool_templates SET enabled = false`);
      await until(manager, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted'`)).rows[0].n === 0);
      for (const vmid of vmids) {
        const events = px.stats.events.filter(e => e.vmid === vmid);
        const removed = events.findIndex(e => e.at === 'ha-remove');
        const stopped = events.findIndex(e => e.at === 'stop');
        if (vmid === vmids[0]) assert.equal(removed, -1, 'no HA to remove');
        else assert.ok(removed >= 0 && stopped > removed, 'ha-remove before stop');
        assert.equal(events[stopped].ha, false);
        assert.equal(px.ha.has(`vm:${vmid}`), false);
        assert.equal(px.guests.has(vmid), false);
      }
    });

    await t.test('fixed node: forced even when another node has more free memory', async () => {
      px.stats.cloneCalls.length = 0;
      await db.query(`UPDATE windows_pool_templates SET enabled = true, node = 'pve-a', ready_target = 1`);
      await until(manager, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'ready'`)).rows[0].n === 1);
      assert.deepEqual(px.stats.cloneCalls.map(call => call.target), ['pve-a']);
      await db.query(`UPDATE windows_pool_templates SET enabled = false`);
      await until(manager, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted'`)).rows[0].n === 0);
    });

    await t.test('reserve on hold while a lab is busy, refilled once it is done', async () => {
      await db.query(`ALTER TABLE lab_deployments ADD COLUMN IF NOT EXISTS status TEXT, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
      const busy = randomUUID();
      const stale = randomUUID();
      await db.query(`INSERT INTO lab_deployments (id, status, updated_at) VALUES ($1, 'customizing', NOW()), ($2, 'deploying', NOW() - interval '5 hours')`, [busy, stale]);
      px.stats.cloneCalls.length = 0;
      await db.query(`UPDATE windows_pool_templates SET enabled = true, node = NULL, storage = 'ceph-pool', ready_target = 1`);
      let result;
      for (let i = 0; i < 5; i += 1) { result = await manager.tick(); await sleep(10); }
      await manager.drain();
      assert.equal(result.busyLabs, 1, 'lab stuck for 5 h ignored');
      assert.equal(result.plans[0].onHold, 'LABS_BUSY');
      assert.equal(px.stats.cloneCalls.length, 0, 'no clone while a lab is being customized');
      await db.query(`UPDATE lab_deployments SET status = 'running' WHERE id = $1`, [busy]);
      await until(manager, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'ready'`)).rows[0].n === 1);
      assert.equal(px.stats.cloneCalls.length, 1, 'reserve refilled once the lab is done');
      await db.query(`DELETE FROM lab_deployments WHERE id = ANY($1::uuid[])`, [[busy, stale]]);
      await db.query(`UPDATE windows_pool_templates SET enabled = false`);
      await until(manager, async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted'`)).rows[0].n === 0);
    });

    await t.test('no node seeing the storage: nothing allocated', async () => {
      px.stats.cloneCalls.length = 0;
      await db.query(`UPDATE windows_pool_templates SET enabled = true, node = NULL, storage = 'missing-store'`);
      for (let i = 0; i < 5; i += 1) { await manager.tick(); await sleep(10); }
      await manager.drain();
      assert.equal(px.stats.cloneCalls.length, 0);
      assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted'`)).rows[0].n, 0);
      await db.query(`UPDATE windows_pool_templates SET enabled = false`);
    });
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
