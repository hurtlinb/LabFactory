// PostgreSQL integration tests for the Windows pool (migration 032 + lib/windowsPool).
// Enabled by WINDOWS_POOL_TEST_DATABASE_URL: a database where the test may create
// and drop an isolated schema. Minimal stubs of vm_templates / lab_deployments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createPoolRequest, reservePoolRequest, cancelPoolRequest } from '../lib/windowsPool/reservation.js';
import { tryAcquireLease, releaseLease, attachProxmoxTask, reconcileOrphanLeases, createLeaseLimiter } from '../lib/windowsPool/leases.js';
import { allocatePoolVm } from '../lib/windowsPool/vmidAllocator.js';
import { transitionPoolVm } from '../lib/windowsPool/states.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;

test('Windows pool: schema, reservation, limits and allocation under concurrency', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 20 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY);
      CREATE TABLE lab_deployments (id UUID PRIMARY KEY);`);
    const migration = await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration); // idempotence (the TS runner replays every file)
    for (const file of ['034-windows-pool-auto-placement.sql', '035-windows-pool-replacements.sql', '036-windows-pool-simplified-activation.sql', '037-windows-pool-global-placement.sql']) {
      await db.query(await fs.readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.query('UPDATE windows_pool_settings SET max_capacity = 10'); // global ceiling (migration 036)

    const templateId = randomUUID();
    const config = { templateId, revision: 1, sourceTemplateVmid: 147, node: 'peda-pve2' };
    await db.query('INSERT INTO vm_templates VALUES ($1)', [templateId]);
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, node, storage, source_template_vmid)
                    VALUES ($1, true, 2, 10, 'peda-pve2', 'ceph-pool', 147)`, [templateId]);
    await db.query('UPDATE windows_pool_settings SET paused = false');
    const deployment = async () => { const id = randomUUID(); await db.query('INSERT INTO lab_deployments VALUES ($1)', [id]); return id; };
    const readyVm = async () => {
      const vm = await allocatePoolVm(db, { templateConfig: config, checkFreeVmid: async id => id });
      const preparing = await transitionPoolVm(db, { id: vm.id, from: 'creating', to: 'preparing', version: vm.version });
      return transitionPoolVm(db, { id: vm.id, from: 'preparing', to: 'ready', version: preparing.version });
    };

    await t.test('constraints: linked clone only, placement global, reserve not bounded per template', async () => {
      await assert.rejects(db.query(`UPDATE windows_pool_templates SET clone_mode = 'full'`), /check/i);
      // 037: node/storage/parallelism are global settings, no longer required per template.
      await db.query('UPDATE windows_pool_templates SET storage = NULL, node = NULL');
      await assert.rejects(db.query('UPDATE windows_pool_settings SET max_parallel_preparations = 0'), /check/i);
      // 036: the ceiling is global, the reserve of a template may exceed its legacy ceiling.
      await db.query('UPDATE windows_pool_templates SET ready_target = 11');
      await db.query('UPDATE windows_pool_templates SET ready_target = 2');
    });

    await t.test('concurrent VMID allocation: unique, in range, Proxmox check required', async () => {
      const vms = await Promise.all(Array.from({ length: 8 }, () => allocatePoolVm(db, { templateConfig: config, checkFreeVmid: async id => id })));
      const ids = vms.map(vm => vm.vmid);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate VMID');
      assert.ok(ids.every(id => id >= 70000 && id <= 79999));
      // VMID taken outside the pool (invisible in the inventory): Proxmox refuses -> next one.
      const taken = new Set([Math.max(...ids) + 1]);
      const next = await allocatePoolVm(db, { templateConfig: config, checkFreeVmid: async id => { if (taken.has(id)) throw new Error('in use'); return id; } });
      assert.ok(!taken.has(next.vmid));
      await db.query(`UPDATE windows_pool_vms SET state = 'deleted'`); // cleanup for the following tests
    });

    await t.test('reservation: all or nothing, explicit waiting, no partial batch', async () => {
      const vm = await readyVm();
      const request = await createPoolRequest(db, { deploymentId: await deployment(), kind: 'deploy', demand: [{ templateId, count: 2 }] });
      const waiting = await reservePoolRequest(db, request.id);
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.reason, 'INSUFFICIENT_STOCK');
      assert.deepEqual(waiting.missing, [{ templateId, count: 2, available: 1 }]);
      const untouched = (await db.query('SELECT state FROM windows_pool_vms WHERE id = $1', [vm.id])).rows[0];
      assert.equal(untouched.state, 'ready', 'no partial reservation');
      await readyVm();
      const reserved = await reservePoolRequest(db, request.id);
      assert.equal(reserved.status, 'reserved');
      assert.equal(reserved.vms.length, 2);
      assert.equal((await reservePoolRequest(db, request.id)).status, 'unchanged');
    });

    await t.test('two concurrent requests never get the same VM', async () => {
      for (let i = 0; i < 3; i++) await readyVm();
      const requests = await Promise.all([1, 2].map(async () => createPoolRequest(db, { deploymentId: await deployment(), kind: 'deploy', demand: [{ templateId, count: 2 }] })));
      // Both reservations start at the same time on separate connections:
      // 3 VMs for 2 x 2 -> only one can be served, without any VM being shared.
      const results = await Promise.all(requests.map(r => reservePoolRequest(db, r.id)));
      const reserved = results.filter(r => r.status === 'reserved');
      assert.equal(reserved.length, 1);
      const ids = reserved.flatMap(r => r.vms.map(vm => vm.id));
      assert.equal(new Set(ids).size, 2);
      const owners = (await db.query(`SELECT COUNT(DISTINCT request_id)::int AS n FROM windows_pool_vms WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n;
      assert.equal(owners, 1);
    });

    await t.test('FIFO per template: a small recent lab does not overtake a large waiting lab', async () => {
      const big = await createPoolRequest(db, { deploymentId: await deployment(), kind: 'deploy', demand: [{ templateId, count: 5 }] });
      const small = await createPoolRequest(db, { deploymentId: await deployment(), kind: 'deploy', demand: [{ templateId, count: 1 }] });
      await db.query(`UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW()
                       WHERE status = 'waiting_for_pool' AND id NOT IN ($1, $2)`, [big.id, small.id]);
      assert.equal((await reservePoolRequest(db, small.id)).reason, 'QUEUED_BEHIND_OLDER_REQUEST');
      while ((await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'ready'`)).rows[0].n < 5) await readyVm();
      assert.equal((await reservePoolRequest(db, big.id)).status, 'reserved');
      assert.equal((await reservePoolRequest(db, small.id)).reason, 'INSUFFICIENT_STOCK');
      await cancelPoolRequest(db, small.id);
    });

    await t.test('suspension and ceiling: explicit blocking, never a direct clone', async () => {
      const request = await createPoolRequest(db, { deploymentId: await deployment(), kind: 'deploy', demand: [{ templateId, count: 11 }] });
      assert.equal((await reservePoolRequest(db, request.id)).reason, 'DEMAND_EXCEEDS_CAPACITY');
      await db.query('UPDATE windows_pool_settings SET paused = true');
      assert.equal((await reservePoolRequest(db, request.id)).reason, 'POOL_PAUSED');
      assert.equal((await db.query('SELECT blocked_reason FROM windows_pool_requests WHERE id = $1', [request.id])).rows[0].blocked_reason, 'POOL_PAUSED');
      await db.query('UPDATE windows_pool_settings SET paused = false');
      await cancelPoolRequest(db, request.id);
    });

    await t.test('cancellation: only re-verified intact VMs return to the stock', async () => {
      while ((await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'ready'`)).rows[0].n < 3) await readyVm();
      const request = await createPoolRequest(db, { deploymentId: await deployment(), kind: 'deploy', demand: [{ templateId, count: 3 }] });
      const { vms } = await reservePoolRequest(db, request.id);
      await transitionPoolVm(db, { id: vms[0].id, from: 'reserved', to: 'configuring', version: vms[0].version });
      const result = await cancelPoolRequest(db, request.id, { verifiedIntactIds: [vms[0].id, vms[1].id] });
      assert.deepEqual(result.released, [vms[1].id]);
      assert.deepEqual(result.toDelete.sort(), [vms[0].id, vms[2].id].sort());
      const states = Object.fromEntries((await db.query('SELECT id, state FROM windows_pool_vms WHERE id = ANY($1::uuid[])', [vms.map(v => v.id)])).rows.map(r => [r.id, r.state]));
      assert.deepEqual([states[vms[0].id], states[vms[1].id], states[vms[2].id]], ['deleting', 'ready', 'deleting']);
    });

    await t.test('assignments: one VM per slot, a pool VM assigned only once', async () => {
      const deploymentId = await deployment();
      const vm = await readyVm();
      const insert = (id, vmid, poolVmId, slot = 1) => db.query(
        `INSERT INTO lab_vm_assignments (id, deployment_id, workstation_number, blueprint_vm_id, manager, cluster, vmid, pool_vm_id)
         VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000001', $4, 'default', $5, $6)`,
        [id, deploymentId, slot, poolVmId ? 'windows-pool' : 'terraform', vmid, poolVmId]);
      await insert(randomUUID(), vm.vmid, vm.id);
      await assert.rejects(insert(randomUUID(), 10001, null), /lab_vm_assignments_active_slot/);
      await assert.rejects(insert(randomUUID(), vm.vmid + 1000, vm.id, 2), /lab_vm_assignments_pool_vm_once/);
      await assert.rejects(db.query(`INSERT INTO lab_vm_assignments (id, deployment_id, workstation_number, blueprint_vm_id, manager, cluster, vmid)
        VALUES ($1, $2, 3, $1, 'windows-pool', 'default', 12345)`, [randomUUID(), deploymentId]), /pool_vm_matches_manager/);
    });

    await t.test('distributed limits: ceiling respected under concurrency, a Proxmox task keeps its budget', async () => {
      await db.query(`UPDATE windows_pool_operation_limits SET max_active = 2 WHERE category = 'clone' AND scope = 'cluster'`);
      await db.query(`INSERT INTO windows_pool_operation_limits (category, scope, max_active) VALUES ('clone', 'node:peda-pve2', 1)`);
      // 10 concurrent attempts (separate connections = distinct replicas).
      const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => tryAcquireLease(db, { category: 'clone', scopes: ['cluster'], holder: 'worker-' + i })));
      const granted = attempts.filter(Boolean);
      assert.equal(granted.length, 2, 'never more than max_active');
      assert.equal(await tryAcquireLease(db, { category: 'clone', scopes: ['cluster'], holder: 'late' }), null);
      await releaseLease(db, granted[0]);
      // Multi-scope: the node limit (1) is checked atomically with the cluster.
      const nodeLease = await tryAcquireLease(db, { category: 'clone', scopes: ['cluster', 'node:peda-pve2'], holder: 'n1' });
      assert.ok(nodeLease);
      assert.equal(await tryAcquireLease(db, { category: 'clone', scopes: ['cluster', 'node:peda-pve2'], holder: 'n2' }), null);
      // Crash: the worker disappears while a Proxmox clone is running.
      await attachProxmoxTask(db, nodeLease, 'UPID:peda-pve2:1:qmclone');
      await db.query(`UPDATE windows_pool_operation_leases SET expires_at = NOW() - interval '1 minute'`);
      assert.equal(await tryAcquireLease(db, { category: 'clone', scopes: ['cluster', 'node:peda-pve2'], holder: 'n3' }), null,
        'an expired lease WITH a running task still counts');
      assert.equal(await reconcileOrphanLeases(db, async () => 'running'), 0);
      assert.equal(await reconcileOrphanLeases(db, async () => { throw new Error('API down'); }), 0, 'fail closed');
      assert.equal(await reconcileOrphanLeases(db, async () => 'stopped'), 2, 'cluster + node released after reconciliation');
      const after = await tryAcquireLease(db, { category: 'clone', scopes: ['cluster', 'node:peda-pve2'], holder: 'n4' });
      assert.ok(after, 'the expired lease without a task (granted[1]) was reclaimed');
    });

    await t.test('customize budget shared by two replicas: ceiling never exceeded (P4d)', async () => {
      await db.query(`UPDATE windows_pool_operation_limits SET max_active = 3 WHERE category = 'customize' AND scope = 'cluster'`);
      const fallback = () => { throw new Error('no fallback expected'); };
      const replicaA = createLeaseLimiter({ pool: db, category: 'customize', holder: 'worker-a', fallback, retryMs: 10 });
      const replicaB = createLeaseLimiter({ pool: db, category: 'customize', holder: 'worker-b', fallback, retryMs: 10 });
      let active = 0, max = 0;
      // 300 ms: longer than a lease acquisition even on a loaded remote database (60 ms was not enough
      // to guarantee 3 simultaneous commands when every test file runs at the same time).
      const command = async () => { active += 1; max = Math.max(max, active); await new Promise(r => setTimeout(r, 300)); active -= 1; };
      await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? replicaA : replicaB)(command)));
      assert.equal(max, 3, 'global ceiling (3) reached, never exceeded, across replicas');
      assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_operation_leases WHERE category = 'customize'`)).rows[0].n, 0);
    });

    await t.test('optimistic concurrency: two workers transition the same VM, only one wins', async () => {
      const vm = await readyVm();
      const results = await Promise.allSettled([
        transitionPoolVm(db, { id: vm.id, from: 'ready', to: 'deleting', version: vm.version }),
        transitionPoolVm(db, { id: vm.id, from: 'ready', to: 'quarantined', version: vm.version })
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.code, 'POOL_VM_STALE');
      const events = (await db.query('SELECT to_state FROM windows_pool_vm_events WHERE pool_vm_id = $1 ORDER BY id', [vm.id])).rows.map(r => r.to_state);
      assert.equal(events.length, 4, 'creating, preparing, ready + a single winning transition');
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
