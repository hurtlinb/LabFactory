// Stock surplus (P6, user decision): reserve lowered or template disabled -> ready VMs destroyed.
// Real PostgreSQL (isolated schema) + simulated Proxmox. Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { createPoolRequest, reservePoolRequest } from '../lib/windowsPool/reservation.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {} };

test('Windows pool: stock surplus destroyed', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_trim_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 20 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT); CREATE TABLE lab_deployments (id UUID PRIMARY KEY, last_job_id TEXT);`);
    await db.query(await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/035-windows-pool-replacements.sql', import.meta.url), 'utf8'));
    await db.query(`UPDATE windows_pool_settings SET paused = false`);
    await db.query(`UPDATE windows_pool_operation_limits SET max_active = 4 WHERE category = 'clone'`);
    const tpl = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [tpl]);
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                    VALUES ($1, true, 5, 8, 5, 'pve-b', 'ceph-pool', 147)`, [tpl]);
    const px = fakeProxmox({ cloneMs: 20 });
    const manager = createPoolManager({ db, proxmox: createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'trim', log: quiet,
      options: { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 } });
    const states = async () => Object.fromEntries((await db.query(`SELECT state, COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted' GROUP BY 1`)).rows.map(r => [r.state, r.n]));
    const until = async (predicate, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error('Condition not reached in time: ' + JSON.stringify(await states()));
        await manager.tick(); await sleep(15);
      }
      await manager.drain();
    };
    await until(async () => (await states()).ready === 5);

    await t.test('reserve lowered: only the surplus is destroyed, the most recent ones are kept', async () => {
      const newest = (await db.query(`SELECT id FROM windows_pool_vms WHERE state = 'ready' ORDER BY ready_at DESC, id LIMIT 2`)).rows.map(r => r.id);
      await db.query('UPDATE windows_pool_templates SET ready_target = 2');
      await until(async () => { const s = await states(); return s.ready === 2 && !s.deleting; });
      const kept = (await db.query(`SELECT id FROM windows_pool_vms WHERE state = 'ready'`)).rows.map(r => r.id).sort();
      assert.deepEqual(kept, newest.sort());
      const codes = (await db.query(`SELECT DISTINCT detail->>'code' AS code FROM windows_pool_vm_events WHERE to_state = 'deleting'`)).rows.map(r => r.code);
      assert.deepEqual(codes, ['STOCK_SURPLUS']);
      assert.equal(px.guests.size - 1, 2, 'destroyed on the Proxmox side (template 147 excluded)');
    });

    await t.test('reserved VMs (labs) are never touched; the waiting demand is kept', async () => {
      const lab = randomUUID();
      await db.query('INSERT INTO lab_deployments VALUES ($1, NULL)', [lab]);
      const reserved = await createPoolRequest(db, { deploymentId: lab, kind: 'deploy', demand: [{ templateId: tpl, count: 1 }] });
      assert.equal((await reservePoolRequest(db, reserved.id)).status, 'reserved');
      const waitingLab = randomUUID();
      await db.query('INSERT INTO lab_deployments VALUES ($1, NULL)', [waitingLab]);
      await db.query(`UPDATE windows_pool_settings SET paused = true`); // the request stays waiting, without being served
      await createPoolRequest(db, { deploymentId: waitingLab, kind: 'deploy', demand: [{ templateId: tpl, count: 1 }] });
      await db.query('UPDATE windows_pool_templates SET ready_target = 0');
      await manager.tick(); await manager.drain();
      const s = await states();
      assert.equal(s.reserved, 1, 'the VM reserved by a lab stays');
      assert.equal(s.ready, 1, 'reserve 0 + demand 1 of the waiting lab = 1 VM kept');
    });

    await t.test('global suspension: the stock is kept; disabled template: its ready VMs are destroyed', async () => {
      assert.equal((await states()).ready, 1, 'paused = true destroys nothing beyond the surplus');
      await db.query(`UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW() WHERE status = 'waiting_for_pool'`);
      await db.query('UPDATE windows_pool_templates SET enabled = false');
      await until(async () => { const s = await states(); return !s.ready && !s.deleting; });
      assert.equal((await states()).reserved, 1, 'still never the reserved VMs');
    });

    await t.test('disabled template: in-flight clones and preparations abandoned, never orphaned', async () => {
      // Slow preparation: VMs stay 'creating'/'preparing' when the template is disabled.
      const slow = fakeProxmox({ cloneMs: 150, prepMs: 60_000 });
      const m2 = createPoolManager({ db, proxmox: createPoolProxmox(slow.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'trim-2', log: quiet,
        options: { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 } });
      await db.query(`UPDATE windows_pool_settings SET paused = false`);
      await db.query('UPDATE windows_pool_templates SET enabled = true, ready_target = 4, max_parallel_preparations = 4');
      const inFlight = async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state IN ('creating','preparing')`)).rows[0].n;
      for (let i = 0; i < 200 && (await inFlight()) < 4; i++) { await m2.tick(); await sleep(10); }
      assert.ok(await inFlight() >= 1, 'preparations in progress');
      await db.query('UPDATE windows_pool_templates SET enabled = false');
      for (let i = 0; i < 400; i++) {
        await m2.tick(); await sleep(15);
        if (!(await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state IN ('creating','preparing','deleting')`)).rows[0].n) break;
      }
      await m2.drain();
      const s = await states();
      assert.ok(!s.creating && !s.preparing && !s.deleting, `nothing left in progress: ${JSON.stringify(s)}`);
      const codes = (await db.query(`SELECT detail->>'code' AS code, COUNT(*)::int AS n FROM windows_pool_vm_events WHERE detail->>'code' = 'TEMPLATE_DISABLED' GROUP BY 1`)).rows;
      assert.ok(codes[0]?.n >= 1);
      assert.equal([...slow.guests.keys()].filter(id => id !== 147).length, 0, 'no orphan VM on the Proxmox side (clone in progress waited for then destroyed)');
    });

    await t.test('many VM operations at once with a small pool: no freeze (dev bug)', async () => {
      // Dev situation: 34 VMs to handle, pool of 20, everything launched at once -> 19 lock connections,
      // queries waiting forever. Here 15 VMs with a pool of 8 and bounded concurrency.
      const small = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 8, connectionTimeoutMillis: 10_000 });
      const burst = fakeProxmox({ cloneMs: 20 });
      try {
        await db.query('UPDATE windows_pool_templates SET enabled = false');
        const ids = [];
        for (let i = 0; i < 15; i++) {
          const id = randomUUID();
          const vmid = 75000 + i;
          burst.guests.set(vmid, { node: 'pve-b', status: 'running', history: [],
            config: { name: `lfpool-${vmid}`, description: `labfactory-pool:${id}`, net0: 'virtio=EE:EE:EE:EE:EE:EE,link_down=1', digest: 'x' } });
          await small.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state)
                              VALUES ($1, $2, 1, 147, 'default', 'pve-b', $3, 'deleting')`, [id, tpl, vmid]);
          ids.push(id);
        }
        const m3 = createPoolManager({ db: small, proxmox: createPoolProxmox(burst.request, { taskPollMs: 5, guestPollMs: 5 }), holder: 'burst', log: quiet,
          options: { maxConcurrentOperations: 3, retryBackoffMs: [20, 40], powerTimeoutMs: 5_000, cloneTimeoutMs: 5_000 } });
        const deadline = Date.now() + 30_000;
        for (;;) {
          await m3.tick(); await sleep(20);
          const left = (await small.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE id = ANY($1::uuid[]) AND state <> 'deleted'`, [ids])).rows[0].n;
          if (!left) break;
          assert.ok(Date.now() < deadline, `operations frozen: ${left} VMs still to destroy`);
        }
        await m3.drain();
        assert.equal([...burst.guests.keys()].filter(id => id >= 75000).length, 0, 'all destroyed on the Proxmox side');
      } finally { await small.end(); }
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
