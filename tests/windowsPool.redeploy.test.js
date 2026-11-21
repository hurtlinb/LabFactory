// Redeploy of workstations with the Windows pool (P5): real PostgreSQL (isolated schema) + simulated Proxmox.
// Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  classifyDeploymentVms, ensureRunPoolRequest, buildAssignmentSlots, runPoolAssignments, finishRunPoolRequest,
  fetchActiveAssignments, overlayAssignments, retireReplacedVms
} from '../lib/windowsPool/deployment.js';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { reservePoolRequest } from '../lib/windowsPool/reservation.js';
import { createPoolAssigner } from '../lib/windowsPool/assignment.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {}, debug() {} };

test('workstation redeploy with the pool (P5)', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_rdp_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 30 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT); CREATE TABLE lab_deployments (id UUID PRIMARY KEY, last_job_id TEXT);`);
    await db.query(await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/035-windows-pool-replacements.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/036-windows-pool-simplified-activation.sql', import.meta.url), 'utf8'));
    await db.query(`UPDATE windows_pool_settings SET paused = false`);
    const tPool = randomUUID(), tLegacy = randomUUID(), tLinux = randomUUID();
    for (const id of [tPool, tLegacy, tLinux]) await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [id]);
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                    VALUES ($1, true, 0, 8, 4, 'pve-b', 'ceph-pool', 147), ($2, false, 0, 8, 4, 'pve-b', 'ceph-pool', 148)`, [tPool, tLegacy]);
    const deploymentId = randomUUID();
    await db.query('INSERT INTO lab_deployments VALUES ($1, NULL)', [deploymentId]);
    const bpWin = randomUUID(), bpLegacy = randomUUID(), bpLinux = randomUUID();
    const vms = [1, 2].flatMap(ws => {
      const nn = String(ws).padStart(2, '0');
      return [
        { id: `${nn}-${bpWin}`, vmid: 12000 + ws * 3, name: `lab-${nn}-srv`, osType: 'windows-server', templateId: tPool, vlanTag: 71 + ws, ipLastOctet: 10, subnetBase: `10.10.${71 + ws}.0` },
        { id: `${nn}-${bpLegacy}`, vmid: 12001 + ws * 3, name: `lab-${nn}-old`, osType: 'windows11', templateId: tLegacy, vlanTag: 71 + ws, ipLastOctet: 11, subnetBase: `10.10.${71 + ws}.0` },
        { id: `${nn}-${bpLinux}`, vmid: 12002 + ws * 3, name: `lab-${nn}-lnx`, osType: 'ubuntu', templateId: tLinux, vlanTag: 71 + ws, ipLastOctet: 12, subnetBase: `10.10.${71 + ws}.0` }
      ];
    });
    const px = fakeProxmox({ cloneMs: 30, templates: [147, 148] });
    // Historical Windows of the lab (Terraform) existing on the Proxmox side.
    for (const vm of vms.filter(v => v.templateId === tLegacy)) {
      px.guests.set(vm.vmid, { node: 'pve-a', status: 'running', history: [], config: { name: vm.name, description: 'terraform', net0: 'virtio=DD:DD:DD:DD:DD:0' + vm.vmid % 10 + ',bridge=vmbr0,tag=72', digest: 'x' } });
    }
    const proxmox = createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 });
    const manager = createPoolManager({ db, proxmox, holder: 'rdp', log: quiet,
      options: { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 } });
    const assigner = createPoolAssigner({ db, proxmox, holder: 'rdp', winrmCheck: async () => {}, log: quiet,
      options: { leaseRetryMs: 10, connectSettleMs: 5, winrmTimeoutMs: 200, winrmRetryMs: 20, guestRetryMs: 20 } });
    const ipConfigFor = vm => `ip=${vm.subnetBase.replace(/\.0$/, '')}.${vm.ipLastOctet}/25,gw=${vm.subnetBase.replace(/\.0$/, '')}.1`;

    // Runs a deploy/redeploy run of the lab as the worker does (classification -> reservation -> retirement -> assignments).
    const runRun = async ({ runId, replaceVmids = [] }) => {
      const effective = overlayAssignments(vms, await fetchActiveAssignments(db, deploymentId));
      const classification = await classifyDeploymentVms(db, { deploymentId, vms: effective, replaceVmids });
      const request = await ensureRunPoolRequest({ db, proxmox, deploymentId, runId, poolVms: classification.poolVms, kind: classification.kind });
      for (let i = 0; i < 400 && (await reservePoolRequest(db, request.id)).status !== 'reserved'; i++) { await manager.tick(); await sleep(20); }
      await manager.drain();
      const reservedVms = (await db.query('SELECT * FROM windows_pool_vms WHERE request_id = $1', [request.id])).rows;
      const plan = buildAssignmentSlots({ poolVms: classification.poolVms, reservedVms, requestId: request.id, deploymentId, deploymentNumber: 3,
        dnsServers: ['195.186.4.162'], templateStorage: () => 'ceph-pool', defaultPassword: 'Shared!pass1', ipConfigFor,
        adminUserFor: () => 'Administrator', replacements: classification.replacements });
      if (classification.replacements.size) await retireReplacedVms({ db, proxmox, replacements: classification.replacements });
      const { assigned, failed } = await runPoolAssignments({ assigner, plan });
      await finishRunPoolRequest(db, request.id, { allAssigned: failed.length === 0 });
      return { classification, assigned, failed, request };
    };

    await t.test('initial deploy: Windows of the enabled template from the pool', async () => {
      const { assigned, failed } = await runRun({ runId: 'deploy-1' });
      assert.equal(failed.length, 0);
      assert.equal(assigned.length, 2);
    });

    let ws1Old;
    await t.test('workstation 1 redeploy: replacement reserved, old one cut off BEFORE the new connects, then destroyed', async () => {
      ws1Old = (await fetchActiveAssignments(db, deploymentId)).find(a => a.workstation_number === 1);
      const effective = overlayAssignments(vms, await fetchActiveAssignments(db, deploymentId));
      const ws1 = effective.filter(v => v.id.startsWith('01-'));
      const replaceVmids = ws1.map(v => v.vmid);
      const { classification, assigned, failed, request } = await runRun({ runId: 'redeploy-1', replaceVmids });
      assert.equal(failed.length, 0);
      assert.equal(request.kind, 'redeploy-workstation');
      // Terraform: the historical Windows (template still disabled) and the Linux of the workstation; the pool slot never.
      assert.deepEqual(classification.terraformTargetVmids, [12004, 12005]);
      assert.ok(!classification.terraformTargetVmids.includes(Number(ws1Old.vmid)));
      const fresh = assigned[0];
      assert.notEqual(fresh.vmid, ws1Old.vmid);
      assert.equal(fresh.ipAddress, '10.10.72.10', 'same IP as the old one');
      const stopOld = px.stats.events.find(e => e.vmid === Number(ws1Old.vmid) && e.at === 'stop');
      const connectNew = px.stats.events.find(e => e.vmid === fresh.vmid && e.at === 'connect');
      assert.ok(stopOld && stopOld.linkDown, 'old one disconnected then stopped');
      assert.ok(stopOld.t <= connectNew.t, 'old one cut off before the new connects');
      const rows = (await db.query('SELECT status, vmid FROM lab_vm_assignments WHERE deployment_id = $1 AND workstation_number = 1 ORDER BY created_at', [deploymentId])).rows;
      assert.deepEqual(rows.map(r => r.status), ['replaced', 'active']);
      const replacing = (await db.query('SELECT replaces_assignment_id FROM lab_vm_assignments WHERE status = \'active\' AND workstation_number = 1 AND deployment_id = $1', [deploymentId])).rows[0];
      assert.equal(replacing.replaces_assignment_id, ws1Old.id, 'replacement history');
      for (let i = 0; i < 200 && px.guests.has(Number(ws1Old.vmid)); i++) { await manager.tick(); await sleep(15); }
      await manager.drain();
      assert.ok(!px.guests.has(Number(ws1Old.vmid)), 'old pool VM destroyed by the manager');
      // Workstation 2 untouched.
      assert.equal((await fetchActiveAssignments(db, deploymentId)).filter(a => a.workstation_number === 2).length, 1);
    });

    await t.test('historical Windows whose template is now enabled: replaced by the pool, the old one targeted by Terraform', async () => {
      await db.query(`UPDATE windows_pool_templates SET enabled = true WHERE template_id = $1`, [tLegacy]);
      const legacy = vms.find(v => v.name === 'lab-02-old');
      const { classification, assigned, failed } = await runRun({ runId: 'redeploy-2', replaceVmids: [legacy.vmid] });
      assert.equal(failed.length, 0);
      assert.deepEqual(classification.retiredTerraformVmids, [legacy.vmid]);
      assert.deepEqual(classification.terraformTargetVmids, [legacy.vmid], 'targeted and absent from the config => destroyed by Terraform');
      assert.ok(!classification.terraformVms.some(v => v.id === legacy.id));
      assert.equal(px.guests.get(legacy.vmid).status, 'stopped');
      assert.match(px.guests.get(legacy.vmid).config.net0, /link_down=1/, 'disconnected before the new one');
      assert.ok(assigned[0].vmid >= 70000);
    });

    await t.test('ownership lost: replacement refused, nothing touched', async () => {
      const ws2 = (await fetchActiveAssignments(db, deploymentId)).find(a => a.workstation_number === 2 && a.blueprint_vm_id === bpWin);
      px.guests.get(Number(ws2.vmid)).config.description = 'someone else';
      const replacements = new Map([['x', { assignment: ws2 }]]);
      await assert.rejects(retireReplacedVms({ db, proxmox, replacements }), error => error.code === 'OWNERSHIP_LOST');
      assert.equal(px.guests.get(Number(ws2.vmid)).status, 'running');
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
