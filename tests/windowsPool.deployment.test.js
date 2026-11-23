// Wiring of the pool into the deploy flow (P4b).
// Pure tests always; PostgreSQL + simulated Proxmox tests if WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  parseSlotId, networkFromIpConfig, buildAssignmentSlots, classifyDeploymentVms, ensureRunPoolRequest,
  runPoolAssignments, finishRunPoolRequest, applyAssignmentsToPayload,
  fetchActiveAssignments, overlayAssignments, terraformManagedVms, teardownDeploymentPool, purgeDeploymentPoolRecords
} from '../lib/windowsPool/deployment.js';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { reservePoolRequest } from '../lib/windowsPool/reservation.js';
import { createPoolAssigner } from '../lib/windowsPool/assignment.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {}, debug() {} };

test('payload identifiers and network rules', () => {
  const bp = randomUUID();
  assert.deepEqual(parseSlotId(`03-${bp}`), { workstationNumber: 3, blueprintVmId: bp });
  assert.throws(() => parseSlotId('vm-01'), /Unexpected/);
  assert.deepEqual(networkFromIpConfig('ip=10.10.72.10/25,gw=10.10.72.1'), { mode: 'static', ipAddress: '10.10.72.10', prefixLength: 25, gateway: '10.10.72.1' });
  assert.deepEqual(networkFromIpConfig('ip=dhcp'), { mode: 'dhcp' });
  assert.throws(() => networkFromIpConfig('ip=10.0.0.1'), /Unexpected/);
});

test('slots: reserved VM of the right template, tags, VLAN, password required', () => {
  const tWin = randomUUID(), tWin11 = randomUUID();
  const bp1 = randomUUID(), bp2 = randomUUID();
  const poolVms = [
    { id: `02-${bp1}`, name: 'lab-02-srv', templateId: tWin, tags: 'ab', vlanTag: 73, ipLastOctet: 10, windowsAdminPassword: 'Ws02!pass', language: 'fr' },
    { id: `01-${bp1}`, name: 'lab-01-srv', templateId: tWin, tags: 'ab', vlanTag: 72, ipLastOctet: 10, language: 'en' },
    { id: `01-${bp2}`, name: 'lab-01-w11', templateId: tWin11, tags: 'ab', vlanTag: 72, ipLastOctet: null, secondDiskSizeGb: 20, language: 'en' }
  ];
  const reservedVms = [{ id: 'p3', vmid: 70003, template_id: tWin }, { id: 'p1', vmid: 70001, template_id: tWin }, { id: 'p2', vmid: 70002, template_id: tWin11 }];
  const plan = buildAssignmentSlots({
    poolVms, reservedVms, requestId: 'r', deploymentId: 'd', deploymentNumber: 42, dnsServers: ['195.186.4.162'],
    templateStorage: () => 'ceph-pool', defaultPassword: 'Shared!pass',
    ipConfigFor: vm => (vm.ipLastOctet == null ? 'ip=dhcp' : `ip=10.10.${vm.vlanTag}.${vm.ipLastOctet}/25,gw=10.10.${vm.vlanTag}.1`),
    adminUserFor: language => (language === 'fr' ? 'Administrateur' : 'Administrator')
  });
  // Matching by template: the 2 VMs of tWin (70001, 70003) go to the srv by workstation order, the W11 to 70002.
  assert.deepEqual(plan.map(p => [p.payloadVm.name, p.vmid]).sort(), [['lab-01-srv', 70001], ['lab-01-w11', 70002], ['lab-02-srv', 70003]]);
  const byName = Object.fromEntries(plan.map(p => [p.payloadVm.name, p.slot]));
  const [s1, w11, s2] = [byName['lab-01-srv'], byName['lab-01-w11'], byName['lab-02-srv']];
  assert.deepEqual([s1.workstationNumber, s1.vlanTag, s1.tags, s1.password, s1.adminUser], [1, 72, ['ab', '42'], 'Shared!pass', 'Administrator']);
  assert.deepEqual([s2.password, s2.adminUser, s2.network.ipAddress], ['Ws02!pass', 'Administrateur', '10.10.73.10'], 'per-workstation password and French account');
  assert.deepEqual([w11.network, w11.secondDisk], [{ mode: 'dhcp' }, { sizeGb: 20, storage: 'ceph-pool' }]);
  assert.throws(() => buildAssignmentSlots({ poolVms, reservedVms: reservedVms.slice(0, 2), requestId: 'r', deploymentId: 'd', dnsServers: [], templateStorage: () => 'x',
    defaultPassword: 'x', ipConfigFor: () => 'ip=dhcp', adminUserFor: () => 'Administrator' }), error => error.code === 'RESERVATION_MISMATCH');
  assert.throws(() => buildAssignmentSlots({ poolVms: [poolVms[1]], reservedVms, requestId: 'r', deploymentId: 'd', dnsServers: [], templateStorage: () => 'x',
    defaultPassword: '', ipConfigFor: () => 'ip=dhcp', adminUserFor: () => 'Administrator' }), error => error.code === 'PASSWORD_MISSING');
});

test('payload after assignment: real VMID and IP of the pool VMs, other VMs unchanged', () => {
  const vms = [{ id: 'a', vmid: 12000 }, { id: 'b', vmid: 12001 }];
  const out = applyAssignmentsToPayload(vms, [{ payloadVm: vms[1], vmid: 70007, ipAddress: '10.0.0.7' }]);
  assert.deepEqual(out, [{ id: 'a', vmid: 12000 }, { id: 'b', vmid: 70007, poolAssigned: true, assignedIpAddress: '10.0.0.7' }]);
});

test('pool deployment flow (P4b)', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_dep_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 30 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT); CREATE TABLE lab_deployments (id UUID PRIMARY KEY, last_job_id TEXT);`);
    await db.query(await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/035-windows-pool-replacements.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/036-windows-pool-simplified-activation.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/037-windows-pool-global-placement.sql', import.meta.url), 'utf8'));
    await db.query(`UPDATE windows_pool_settings SET paused = false`);
    const tPool = randomUUID(), tLegacy = randomUUID(), tLinux = randomUUID();
    for (const id of [tPool, tLegacy, tLinux]) await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [id]);
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                    VALUES ($1, true, 0, 6, 4, 'pve-b', 'ceph-pool', 147), ($2, false, 0, 6, 4, NULL, NULL, 148)`, [tPool, tLegacy]);
    await db.query(`UPDATE windows_pool_settings SET node = 'pve-b', storage = 'ceph-pool', max_parallel_preparations = 4`); // global placement (migration 037)
    const deploymentId = randomUUID();
    await db.query('INSERT INTO lab_deployments VALUES ($1, NULL)', [deploymentId]);
    const bpWin = randomUUID(), bpLegacy = randomUUID(), bpLinux = randomUUID();
    // 2 workstations: pool Windows + legacy Windows (template not enabled) + Linux.
    const vms = [1, 2].flatMap(ws => {
      const nn = String(ws).padStart(2, '0');
      return [
        { id: `${nn}-${bpWin}`, vmid: 12000 + ws * 3, name: `lab-${nn}-srv`, osType: 'windows-server', templateId: tPool, tags: 'ab', vlanTag: 71 + ws, ipLastOctet: 10, subnetBase: `10.10.${71 + ws}.0` },
        { id: `${nn}-${bpLegacy}`, vmid: 12001 + ws * 3, name: `lab-${nn}-old`, osType: 'windows11', templateId: tLegacy, vlanTag: 71 + ws, ipLastOctet: 11, subnetBase: `10.10.${71 + ws}.0` },
        { id: `${nn}-${bpLinux}`, vmid: 12002 + ws * 3, name: `lab-${nn}-lnx`, osType: 'ubuntu', templateId: tLinux, vlanTag: 71 + ws, ipLastOctet: 12, subnetBase: `10.10.${71 + ws}.0` }
      ];
    });

    await t.test('classification: only the Windows of an enabled template go through the pool', async () => {
      const { poolVms, terraformVms } = await classifyDeploymentVms(db, { deploymentId, vms });
      assert.deepEqual(poolVms.map(v => v.name).sort(), ['lab-01-srv', 'lab-02-srv']);
      assert.deepEqual(terraformVms.map(v => v.name).sort(), ['lab-01-lnx', 'lab-01-old', 'lab-02-lnx', 'lab-02-old']);
      const none = await classifyDeploymentVms(db, { deploymentId, vms: vms.filter(v => v.templateId !== tPool) });
      assert.equal(none.poolVms.length, 0, 'lab without an enabled template: unchanged flow');
    });

    let request;
    await t.test('run request: created once, reused on resume, replaced for a new run', async () => {
      const { poolVms } = await classifyDeploymentVms(db, { deploymentId, vms });
      const first = await ensureRunPoolRequest({ db, proxmox: null, deploymentId, runId: 'run-1', poolVms });
      assert.deepEqual(first.demand, [{ templateId: tPool, count: 2 }]);
      assert.equal((await ensureRunPoolRequest({ db, proxmox: null, deploymentId, runId: 'run-1', poolVms })).id, first.id, 'resumed delayed job');
      request = await ensureRunPoolRequest({ db, proxmox: null, deploymentId, runId: 'run-2', poolVms });
      assert.notEqual(request.id, first.id);
      assert.equal((await db.query('SELECT status FROM windows_pool_requests WHERE id = $1', [first.id])).rows[0].status, 'cancelled');
    });

    let px, proxmox, manager; // shared with the P5 tests (same lab, same simulated Proxmox)
    await t.test('end to end: reservation, parallel assignments, request closed, payload for Ansible', async () => {
      px = fakeProxmox({ cloneMs: 30 });
      proxmox = createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 });
      manager = createPoolManager({ db, proxmox, holder: 'dep', log: quiet,
        options: { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 } });
      for (let i = 0; i < 400 && (await reservePoolRequest(db, request.id)).status !== 'reserved'; i++) { await manager.tick(); await sleep(20); }
      await manager.drain();
      const reservedVms = (await db.query(`SELECT * FROM windows_pool_vms WHERE request_id = $1`, [request.id])).rows;
      assert.equal(reservedVms.length, 2);
      const { poolVms } = await classifyDeploymentVms(db, { deploymentId, vms });
      const plan = buildAssignmentSlots({
        poolVms, reservedVms, requestId: request.id, deploymentId, deploymentNumber: 7, dnsServers: ['195.186.4.162', '195.186.4.163'],
        templateStorage: () => 'ceph-pool', defaultPassword: 'Shared!pass1',
        ipConfigFor: vm => `ip=${vm.subnetBase.replace(/\.0$/, '')}.${vm.ipLastOctet}/25,gw=${vm.subnetBase.replace(/\.0$/, '')}.1`,
        adminUserFor: () => 'Administrator',
        labProxmoxPool: 'labs-dev'
      });
      assert.ok(plan.every(item => item.slot.proxmoxPool === 'labs-dev'));
      const assigner = createPoolAssigner({ db, proxmox, holder: 'dep', winrmCheck: async () => {}, log: quiet,
        options: { leaseRetryMs: 10, connectSettleMs: 5, winrmTimeoutMs: 200, winrmRetryMs: 20, guestRetryMs: 20 } });
      const { assigned, failed } = await runPoolAssignments({ assigner, plan });
      assert.equal(failed.length, 0);
      await finishRunPoolRequest(db, request.id, { allAssigned: true });
      assert.equal((await db.query('SELECT status FROM windows_pool_requests WHERE id = $1', [request.id])).rows[0].status, 'fulfilled');
      const payload = applyAssignmentsToPayload(vms, assigned);
      const srv1 = payload.find(v => v.name === 'lab-01-srv');
      assert.ok(srv1.vmid >= 70000 && srv1.poolAssigned, 'real pool VMID passed to readiness/customization');
      assert.equal(srv1.assignedIpAddress, '10.10.72.10');
      assert.equal(payload.find(v => v.name === 'lab-01-lnx').vmid, 12005, 'Terraform VM unchanged');
      const g = px.guests.get(srv1.vmid);
      assert.equal(g.config.tags, 'labfactory-pool;ab;7');
      assert.match(g.config.net0, /tag=72,link_down=0/);
      assert.equal(g.pool, 'labs-dev', 'lab VM moved into the labs Proxmox pool');
      const slots = (await db.query(`SELECT workstation_number, manager FROM lab_vm_assignments WHERE deployment_id = $1 AND status = 'active' ORDER BY 1`, [deploymentId])).rows;
      assert.deepEqual(slots, [{ workstation_number: 1, manager: 'windows-pool' }, { workstation_number: 2, manager: 'windows-pool' }]);
    });

    await t.test('P5 effective plan: real VMIDs of the pool slots, historical VMs unchanged, Terraform excludes them', async () => {
      const assignments = await fetchActiveAssignments(db, deploymentId);
      const effective = overlayAssignments(vms, assignments);
      const srv = effective.filter(v => v.name.endsWith('-srv'));
      assert.ok(srv.every(v => v.vmid >= 70000 && v.manager === 'windows-pool' && v.poolVmId));
      assert.deepEqual(effective.filter(v => !v.name.endsWith('-srv')).map(v => v.vmid), vms.filter(v => !v.name.endsWith('-srv')).map(v => v.vmid));
      assert.deepEqual(terraformManagedVms(effective).map(v => v.name).sort(), ['lab-01-lnx', 'lab-01-old', 'lab-02-lnx', 'lab-02-old']);
      assert.deepEqual(overlayAssignments(vms, []), vms, 'without assignment: computed plan unchanged');
    });

    await t.test('redeploy: workstation served by the pool replaced by the pool (P5), historical workstation unchanged', async () => {
      const ws1Pool = vms.find(v => v.name === 'lab-01-srv');
      const replaced = await classifyDeploymentVms(db, { deploymentId, vms, replaceVmids: [ws1Pool.vmid] });
      assert.deepEqual(replaced.poolVms.map(v => v.name), ['lab-01-srv']);
      assert.equal(replaced.kind, 'redeploy-workstation');
      assert.ok(replaced.replacements.get(ws1Pool.id)?.assignment, 'old assignment to replace');
      assert.deepEqual(replaced.terraformTargetVmids, [], 'no Terraform at all (no -target would mean the whole lab)');
      const legacy = vms.find(v => v.name === 'lab-02-old');
      const { poolVms, terraformVms } = await classifyDeploymentVms(db, { deploymentId, vms, replaceVmids: [legacy.vmid] });
      assert.equal(poolVms.length, 0);
      assert.ok(!terraformVms.some(v => v.templateId === tPool), 'slots served by the pool never in the Terraform definitions');
      assert.equal(terraformVms.length, 4);
    });

    await t.test('P5 destroy: assignments closed, pool VMs destroyed by the manager, lab purgeable', async () => {
      const poolVmids = (await fetchActiveAssignments(db, deploymentId)).map(a => a.vmid);
      assert.equal(poolVmids.length, 2);
      await assert.rejects(purgeDeploymentPoolRecords(db, deploymentId), error => error.code === 'POOL_VMS_LIVING', 'deleting the record before the destroy is refused');
      // The manager (pool worker) runs alongside: it destroys the VMs moved to 'deleting'.
      let running = true;
      const loop = (async () => { while (running) { await manager.tick(); await sleep(15); } })();
      try {
        const result = await teardownDeploymentPool({ db, proxmox, deploymentId, pollMs: 20, timeoutMs: 15_000, log: quiet });
        assert.equal(result.vms, 2);
      } finally { running = false; await loop; await manager.drain(); }
      assert.ok(poolVmids.every(vmid => !px.guests.has(vmid)), 'pool VMs destroyed on the Proxmox side');
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM lab_vm_assignments WHERE deployment_id = $1', [deploymentId])).rows[0].n, 0);
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM windows_pool_requests WHERE deployment_id = $1', [deploymentId])).rows[0].n, 0);
      await db.query('DELETE FROM lab_deployments WHERE id = $1', [deploymentId]); // the RESTRICT FKs no longer block
      const events = (await db.query(`SELECT detail->>'code' AS code FROM windows_pool_vm_events WHERE to_state = 'deleting' AND detail->>'deploymentId' = $1`, [deploymentId])).rows;
      assert.deepEqual(events.map(e => e.code), ['LAB_DESTROYED', 'LAB_DESTROYED']);
    });

    await t.test('P5 destroy without the pool worker: explicit timeout, the lab keeps its information', async () => {
      const lab = randomUUID();
      await db.query('INSERT INTO lab_deployments VALUES ($1, NULL)', [lab]);
      const vmId = randomUUID(), requestId = randomUUID();
      await db.query(`INSERT INTO windows_pool_requests (id, deployment_id, kind, demand, status) VALUES ($1, $2, 'deploy', $3, 'fulfilled')`,
        [requestId, lab, JSON.stringify([{ templateId: tPool, count: 1 }])]);
      await db.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state, request_id)
                      VALUES ($1, $2, 1, 147, 'default', 'pve-b', 70990, 'assigned', $3)`, [vmId, tPool, requestId]);
      await db.query(`INSERT INTO lab_vm_assignments (id, deployment_id, workstation_number, blueprint_vm_id, manager, cluster, vmid, pool_vm_id, request_id)
                      VALUES ($1, $2, 1, $3, 'windows-pool', 'default', 70990, $4, $5)`, [randomUUID(), lab, randomUUID(), vmId, requestId]);
      await assert.rejects(teardownDeploymentPool({ db, proxmox: null, deploymentId: lab, pollMs: 10, timeoutMs: 100, log: quiet }),
        error => error.code === 'POOL_TEARDOWN_TIMEOUT' && /70990/.test(error.message));
      assert.equal((await db.query('SELECT state FROM windows_pool_vms WHERE id = $1', [vmId])).rows[0].state, 'deleting');
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM windows_pool_requests WHERE deployment_id = $1', [lab])).rows[0].n, 1, 'information kept');
      await assert.rejects(db.query('DELETE FROM lab_deployments WHERE id = $1', [lab]), /foreign key/, 'the lab cannot disappear while its VMs live');
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});

// Lab 188 in dev (22 VMs): every assignment started at once exhausted the pg pool of the
// Terraform worker (one lock connection per chain + one for its queries) -> frozen forever.
test('runPoolAssignments: bounded concurrency, results kept per slot', async () => {
  let running = 0;
  let max = 0;
  const warmed = [];
  const assigner = {
    warmUp: async vmid => { warmed.push(vmid); return true; },
    assign: async poolVmId => {
      running += 1; max = Math.max(max, running);
      await sleep(5);
      running -= 1;
      if (poolVmId === 'vm-7') throw Object.assign(new Error('boom'), { code: 'WINRM_FAILED' });
      return { vmid: 70000 + Number(poolVmId.slice(3)), ipAddress: null };
    }
  };
  const plan = Array.from({ length: 22 }, (_, i) => ({ poolVmId: `vm-${i}`, vmid: 70000 + i, slot: { network: { ipAddress: `10.0.0.${i}` } } }));
  const { assigned, failed } = await runPoolAssignments({ assigner, plan, concurrency: 4 });
  assert.deepEqual(warmed, plan.slice(4).map(p => p.vmid), 'VMs waiting for a slot warmed up front');
  assert.equal(max, 4, 'never more than 4 chains at once');
  assert.equal(assigned.length, 21);
  assert.deepEqual(failed.map(f => [f.poolVmId, f.error.code]), [['vm-7', 'WINRM_FAILED']]);
  assert.deepEqual(assigned.map(a => a.vmid), plan.filter(p => p.poolVmId !== 'vm-7').map(p => 70000 + Number(p.poolVmId.slice(3))), 'order of the plan kept');
  assert.equal(assigned[0].ipAddress, '10.0.0.0');
});
