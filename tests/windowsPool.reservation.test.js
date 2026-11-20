// Reservation and waiting (P3): real PostgreSQL (isolated schema) + simulated Proxmox.
// Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DelayedError } from 'bullmq';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { createReservationCoordinator } from '../lib/windowsPool/coordinator.js';
import { createPoolRequest, reservePoolRequest } from '../lib/windowsPool/reservation.js';
import { awaitPoolReservation, promoteDeploymentJob, PoolRequestClosedError } from '../lib/windowsPool/waiting.js';
import { cancelPoolRequestVerified } from '../lib/windowsPool/cancellation.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {} };
const fast = { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 };

async function waitFor(predicate, { timeoutMs = 15_000, step } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (step) await step();
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('Condition not reached in time');
    await sleep(20);
  }
}

test('Windows pool reservation and waiting (P3)', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_res_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 30 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT);
                    CREATE TABLE lab_deployments (id UUID PRIMARY KEY, last_job_id TEXT);`);
    await db.query(await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8'));
    await db.query(`UPDATE windows_pool_settings SET paused = false`);
    await db.query(`UPDATE windows_pool_operation_limits SET max_active = 4 WHERE category = 'clone'`);
    const tA = randomUUID(), tB = randomUUID();
    for (const [id, vmid] of [[tA, 147], [tB, 148]]) {
      await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [id]);
      await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                      VALUES ($1, true, 0, 4, 4, 'pve-b', 'ceph-pool', $2)`, [id, vmid]);
    }
    const deployment = async (jobId = null) => { const id = randomUUID(); await db.query('INSERT INTO lab_deployments VALUES ($1, $2)', [id, jobId]); return id; };
    const request = async (demand, jobId) => createPoolRequest(db, { deploymentId: await deployment(jobId), kind: 'deploy', demand });
    const status = async id => (await db.query('SELECT status, blocked_reason FROM windows_pool_requests WHERE id = $1', [id])).rows[0];
    const cancelWaiting = () => db.query(`UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW() WHERE status IN ('waiting_for_pool')`);

    const px = fakeProxmox({ templates: [147, 148], cloneMs: 50 });
    const proxmox = createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 });
    const manager = createPoolManager({ db, proxmox, holder: 'res-test', log: quiet, options: fast });
    const reservedEvents = [];
    const coordinator = createReservationCoordinator({ db, log: quiet, onReserved: event => { reservedEvents.push(event.requestId); } });

    await t.test('empty pool: the lab waits, the demand triggers the preparation, the stock notification serves it', async () => {
      const stop = await coordinator.listen();
      try {
        const r = await request([{ templateId: tA, count: 2 }]);
        // Notification at creation: immediate attempt -> explicit waiting, nothing reserved.
        await waitFor(async () => (await status(r.id)).blocked_reason === 'INSUFFICIENT_STOCK');
        assert.equal((await status(r.id)).status, 'waiting_for_pool');
        // Only the manager runs; the reservation must happen through the notification alone (no manual reconcile).
        await waitFor(async () => (await status(r.id)).status === 'reserved', { step: async () => { await manager.tick(); }, timeoutMs: 20_000 });
        await manager.drain();
        assert.deepEqual(reservedEvents, [r.id]);
        const vms = (await db.query(`SELECT state FROM windows_pool_vms WHERE request_id = $1`, [r.id])).rows;
        assert.deepEqual(vms.map(v => v.state), ['reserved', 'reserved']);
      } finally { await stop(); }
    });

    await t.test('a waiting lab blocks neither an independent lab nor the replenishment', async () => {
      // Template A suspended: this lab waits (older), lab B (more recent, independent) must not wait.
      await db.query(`UPDATE windows_pool_templates SET enabled = false WHERE template_id = $1`, [tA]);
      const waitingA = await request([{ templateId: tA, count: 2 }]);
      const servedB = await request([{ templateId: tB, count: 1 }]);
      await waitFor(async () => (await status(servedB.id)).status === 'reserved',
        { step: async () => { await manager.tick(); await coordinator.reconcile(); }, timeoutMs: 20_000 });
      await manager.drain();
      assert.equal((await status(waitingA.id)).status, 'waiting_for_pool');
      assert.equal((await status(waitingA.id)).blocked_reason, 'TEMPLATE_DISABLED');
      // As soon as A is reactivated, its replenishment and the reservation resume.
      await db.query(`UPDATE windows_pool_templates SET enabled = true WHERE template_id = $1`, [tA]);
      await waitFor(async () => (await status(waitingA.id)).status === 'reserved',
        { step: async () => { await manager.tick(); await coordinator.reconcile(); }, timeoutMs: 20_000 });
      await manager.drain();
    });

    await t.test('head-of-line: an unservable request does not block the following ones; the stock queue stays FIFO', async () => {
      await db.query(`UPDATE windows_pool_templates SET ready_target = 0`);
      // Free stock: 1 ready VM of A.
      await db.query(`UPDATE windows_pool_templates SET ready_target = 1 WHERE template_id = $1`, [tA]);
      await waitFor(async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE template_id = $1 AND state = 'ready'`, [tA])).rows[0].n === 1,
        { step: () => manager.tick(), timeoutMs: 20_000 });
      await manager.drain();
      await db.query(`UPDATE windows_pool_templates SET ready_target = 0 WHERE template_id = $1`, [tA]);
      const tooBig = await request([{ templateId: tA, count: 9 }]); // > ceiling 4
      const small = await request([{ templateId: tA, count: 1 }]);
      await coordinator.reconcile();
      assert.equal((await status(tooBig.id)).blocked_reason, 'DEMAND_EXCEEDS_CAPACITY');
      assert.equal((await status(small.id)).status, 'reserved', 'the unservable request does not block');
      // Disabled template: an older A+B request does not block a more recent B request.
      await db.query(`UPDATE windows_pool_templates SET enabled = false WHERE template_id = $1`, [tA]);
      const mixed = await request([{ templateId: tA, count: 1 }, { templateId: tB, count: 1 }]);
      const onlyB = await request([{ templateId: tB, count: 1 }]);
      await waitFor(async () => (await status(onlyB.id)).status === 'reserved',
        { step: async () => { await manager.tick(); await coordinator.reconcile(); }, timeoutMs: 20_000 });
      await manager.drain();
      assert.equal((await status(mixed.id)).blocked_reason, 'TEMPLATE_DISABLED');
      await db.query(`UPDATE windows_pool_templates SET enabled = true WHERE template_id = $1`, [tA]);
      await cancelWaiting();
    });

    await t.test('BullMQ waiting: no attempt or slot consumed, progress published, wake-up', async () => {
      const r = await request([{ templateId: tA, count: 3 }], 'job-42');
      await coordinator.reconcile();
      const calls = [];
      const job = { updateProgress: async p => calls.push(['progress', p]), moveToDelayed: async (ts, token) => calls.push(['delayed', token, ts > Date.now()]) };
      await assert.rejects(awaitPoolReservation({ db, requestId: r.id, job, token: 'tok' }), error => error instanceof DelayedError);
      assert.equal(calls[0][1].phase, 'waiting_for_pool');
      assert.equal(calls[0][1].blockedReason, 'INSUFFICIENT_STOCK');
      assert.deepEqual(calls[1], ['delayed', 'tok', true]);
      // Promotion of the delayed job once the reservation is obtained.
      const promoted = [];
      const queue = { getJob: async id => ({ id, getState: async () => 'delayed', promote: async () => promoted.push(id) }) };
      assert.equal(await promoteDeploymentJob({ db, queue, requestId: r.id }), true);
      assert.deepEqual(promoted, ['job-42']);
      const notDelayed = { getJob: async () => ({ getState: async () => 'active', promote: async () => assert.fail('must not promote') }) };
      assert.equal(await promoteDeploymentJob({ db, queue: notDelayed, requestId: r.id }), false);
      // Reservation obtained -> the VMs are returned.
      await waitFor(async () => (await status(r.id)).status === 'reserved',
        { step: async () => { await manager.tick(); await coordinator.reconcile(); }, timeoutMs: 20_000 });
      await manager.drain();
      const done = await awaitPoolReservation({ db, requestId: r.id, job, token: 'tok' });
      assert.equal(done.vms.length, 3);
      // Closed request -> explicit error, never a direct clone.
      await db.query(`UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW() WHERE id = $1`, [r.id]);
      await assert.rejects(awaitPoolReservation({ db, requestId: r.id, job, token: 'tok' }), PoolRequestClosedError);
    });

    await t.test('verified cancellation: only a VM proven intact returns to the stock', async () => {
      await db.query(`UPDATE windows_pool_vms SET state = 'deleting' WHERE state IN ('reserved', 'ready')`);
      await waitFor(async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state = 'deleting'`)).rows[0].n === 0,
        { step: () => manager.tick(), timeoutMs: 20_000 });
      await manager.drain();
      const r = await request([{ templateId: tB, count: 3 }]);
      await waitFor(async () => (await status(r.id)).status === 'reserved',
        { step: async () => { await manager.tick(); await coordinator.reconcile(); }, timeoutMs: 20_000 });
      await manager.drain();
      const [intact, reconnected, foreignMarker] = (await db.query(`SELECT * FROM windows_pool_vms WHERE request_id = $1 ORDER BY vmid`, [r.id])).rows;
      const g = px.guests.get(reconnected.vmid);
      g.config.net0 = g.config.net0.replace('link_down=1', 'link_down=0');
      px.guests.get(foreignMarker.vmid).marker = { poolVmId: randomUUID(), revision: 1 };
      const result = await cancelPoolRequestVerified({ db, proxmox, requestId: r.id });
      assert.deepEqual(result.released, [intact.id]);
      assert.deepEqual(result.toDelete.sort(), [reconnected.id, foreignMarker.id].sort());
      assert.deepEqual(Object.fromEntries(result.checks.map(c => [c.vmid, c.reason ?? 'OK'])),
        { [intact.vmid]: 'OK', [reconnected.vmid]: 'NIC_CONNECTED', [foreignMarker.vmid]: 'MARKER_MISMATCH' });
      assert.equal((await status(r.id)).status, 'cancelled');
      // The manager destroys the non-intact VMs.
      await waitFor(async () => !px.guests.has(reconnected.vmid) && !px.guests.has(foreignMarker.vmid), { step: () => manager.tick(), timeoutMs: 20_000 });
      await manager.drain();
      assert.ok(px.guests.has(intact.vmid));
      assert.equal((await db.query('SELECT state FROM windows_pool_vms WHERE id = $1', [intact.id])).rows[0].state, 'ready');
    });

    await t.test('concurrent coordinators (replicas): no double reservation', async () => {
      await db.query(`UPDATE windows_pool_templates SET ready_target = 4, max_capacity = 6 WHERE template_id = $1`, [tB]);
      await waitFor(async () => (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE template_id = $1 AND state = 'ready'`, [tB])).rows[0].n >= 4,
        { step: () => manager.tick(), timeoutMs: 20_000 });
      await manager.drain();
      await db.query(`UPDATE windows_pool_templates SET ready_target = 0`);
      const requests = [];
      for (let i = 0; i < 4; i++) requests.push(await request([{ templateId: tB, count: 1 }]));
      const replicas = [1, 2, 3].map(() => createReservationCoordinator({ db, log: quiet }));
      const countOwners = async () => (await db.query(`SELECT request_id, COUNT(*)::int AS n FROM windows_pool_vms WHERE request_id = ANY($1::uuid[]) AND state = 'reserved' GROUP BY 1`,
        [requests.map(r => r.id)])).rows;
      await Promise.all(replicas.map(c => c.reconcile()));
      assert.ok((await countOwners()).every(o => o.n === 1), 'concurrent replicas: one VM per request, never two');
      // A replica may have left a request "behind" another one being committed: the next pass serves it.
      await replicas[0].reconcile();
      const owners = await countOwners();
      assert.equal(owners.length, 4, 'each request served');
      assert.ok(owners.every(o => o.n === 1));
      const reservedCount = (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE request_id = ANY($1::uuid[])`, [requests.map(r => r.id)])).rows[0].n;
      assert.equal(reservedCount, 4);
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
