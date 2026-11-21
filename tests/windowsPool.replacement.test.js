// Windows pool: replacement of the VMs that fail their assignment (user decision 2026-11-21).
// Real PostgreSQL (isolated schema) + simulated Proxmox. Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { createPoolRequest, reservePoolRequest } from '../lib/windowsPool/reservation.js';
import { createPoolAssigner } from '../lib/windowsPool/assignment.js';
import { runPoolAssignments, createPoolReplacer } from '../lib/windowsPool/deployment.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {}, debug() {} };

test('runPoolAssignments: a failed VM is replaced, the slot keeps its place', async () => {
  const assigner = {
    assign: async poolVmId => {
      if (poolVmId === 'bad') throw Object.assign(new Error('WinRM down'), { code: 'WINRM_FAILED' });
      return { vmid: poolVmId === 'spare' ? 70099 : 70000, ipAddress: null };
    }
  };
  const plan = [{ poolVmId: 'bad', vmid: 70001, payloadVm: { name: 'srv-01' }, slot: { network: { ipAddress: '10.0.0.1' } } }];
  const replace = async item => ({ ...item, poolVmId: 'spare', vmid: 70099 });
  const onAssigned = [];
  const { assigned, failed, replacements } = await runPoolAssignments({ assigner, plan, replace, onAssigned: (item, value) => onAssigned.push([item.payloadVm.name, value.vmid]) });
  assert.deepEqual(onAssigned, [['srv-01', 70099]], 'lab page progress: one call per integrated slot, real VMID');
  assert.equal(failed.length, 0);
  assert.deepEqual([assigned[0].vmid, assigned[0].ipAddress], [70099, '10.0.0.1']);
  assert.deepEqual(replacements.map(r => [r.slot, r.vmid, r.code]), [['srv-01', 70001, 'WINRM_FAILED']]);
});

test('Windows pool: replacement of the VMs in error during the assignment', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_repl_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 30 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT);
                    CREATE TABLE lab_deployments (id UUID PRIMARY KEY, status TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    for (const file of ['032-windows-pool.sql', '034-windows-pool-auto-placement.sql', '035-windows-pool-replacements.sql', '035-windows-pool-replacements.sql']) {
      await db.query(await fs.readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8')); // 035 replayed: idempotent
    }
    await db.query(`UPDATE windows_pool_settings SET paused = false, proxmox_pool = 'pool-test'`);
    const templateId = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [templateId]);
    // Reserve 1 (on hold while the lab is deploying), ceiling 10.
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                    VALUES ($1, true, 1, 10, 6, 'pve-a', 'ceph-pool', 147)`, [templateId]);
    const px = fakeProxmox({ cloneMs: 30 });
    const proxmox = createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 });
    const manager = createPoolManager({ db, proxmox, holder: 'repl', log: quiet,
      options: { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 } });
    const assigner = createPoolAssigner({ db, proxmox, holder: 'repl', winrmCheck: async () => {}, log: quiet,
      options: { leaseRetryMs: 10, connectSettleMs: 5, winrmTimeoutMs: 200, winrmRetryMs: 20, guestRetryMs: 20 } });

    // Manager ticking in the background while the assignments run (it creates the replacements).
    let ticking = true;
    const ticker = (async () => { while (ticking) { await manager.tick(); await sleep(15); } await manager.drain(); })();

    // Lab of `count` pool VMs, reserved; `defects` of them fail their assignment.
    const lab = async (count, defects) => {
      const deploymentId = randomUUID();
      await db.query(`INSERT INTO lab_deployments (id, status) VALUES ($1, 'deploying')`, [deploymentId]);
      const request = await createPoolRequest(db, { deploymentId, kind: 'deploy', demand: [{ templateId, count }] });
      for (let i = 0; i < 500 && (await reservePoolRequest(db, request.id)).status !== 'reserved'; i++) await sleep(20);
      const vms = (await db.query(`SELECT * FROM windows_pool_vms WHERE request_id = $1 ORDER BY vmid`, [request.id])).rows;
      assert.equal(vms.length, count);
      for (const vm of vms.slice(0, defects)) px.guests.get(vm.vmid).wuPauseDefect = true;
      const plan = vms.map((vm, i) => ({
        poolVmId: vm.id, vmid: vm.vmid,
        payloadVm: { id: `slot-${i}`, name: `lab-${String(i + 1).padStart(2, '0')}-srv`, templateId },
        slot: {
          requestId: request.id, deploymentId, workstationNumber: i + 1, blueprintVmId: randomUUID(),
          name: `lab-${String(i + 1).padStart(2, '0')}-srv`, tags: ['ab'], vlanTag: 72, osType: 'windows-server',
          network: { mode: 'static', ipAddress: `10.10.72.${10 + i}`, prefixLength: 25, gateway: '10.10.72.1' },
          dnsServers: ['195.186.4.162'], adminUser: 'Administrator', password: 'Final-Pa55word!'
        }
      }));
      const replace = createPoolReplacer({ db, requestId: request.id, total: count, pollMs: 20, timeoutMs: 20_000, log: quiet });
      return { request, vms, plan, replace, result: await runPoolAssignments({ assigner, plan, concurrency: 3, replace }) };
    };
    const state = async id => (await db.query('SELECT state, error_code FROM windows_pool_vms WHERE id = $1', [id])).rows[0];

    await t.test('VM in error: quarantined, replaced (created although the lab is busy), slot assigned', async () => {
      const { request, vms, replace, result } = await lab(3, 1);
      assert.equal(replace.budget, 1, '10% of 3, at least 1');
      assert.equal(result.failed.length, 0, 'lab not failed');
      assert.equal(result.assigned.length, 3);
      assert.deepEqual((await state(vms[0].id)), { state: 'quarantined', error_code: 'WU_PAUSE_FAILED' });
      const slot1 = result.assigned.find(a => a.payloadVm.id === 'slot-0');
      assert.notEqual(slot1.vmid, vms[0].vmid, 'slot 1 served by another VM');
      assert.equal((await db.query(`SELECT state FROM windows_pool_vms WHERE vmid = $1`, [slot1.vmid])).rows[0].state, 'assigned');
      assert.deepEqual(result.replacements.map(r => [r.vmid, r.code]), [[vms[0].vmid, 'WU_PAUSE_FAILED']]);
      const reservedEvent = (await db.query(
        `SELECT e.detail FROM windows_pool_vm_events e JOIN windows_pool_vms v ON v.id = e.pool_vm_id WHERE v.vmid = $1 AND e.to_state = 'reserved'`, [slot1.vmid])).rows[0].detail;
      assert.equal(reservedEvent.replacementFor, vms[0].id);
      const after = (await db.query('SELECT status, replacement_demand FROM windows_pool_requests WHERE id = $1', [request.id])).rows[0];
      assert.deepEqual([after.status, after.replacement_demand], ['reserved', {}], 'replacement need withdrawn once served');
      assert.ok(!px.stats.events.some(e => e.vmid === vms[0].vmid && e.at === 'connect'), 'faulty VM never connected');
    });

    await t.test('budget exhausted (more than 10% in error): the remaining slot fails', async () => {
      const { result } = await lab(3, 2);
      assert.equal(result.replacements.length, 1, 'one replacement only (budget 1)');
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].error.code, 'WU_PAUSE_FAILED');
      assert.equal(result.assigned.length, 2);
    });

    ticking = false;
    await ticker;
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
