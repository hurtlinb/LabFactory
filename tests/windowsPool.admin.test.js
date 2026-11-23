// Windows pool administration (P6): real PostgreSQL (isolated schema). Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  getPoolOverview, updatePoolSettings, setTemplatePool, syncTemplateModel, purgeTemplatePoolHistory,
  updateOperationLimit, destroyQuarantinedVm, getVmTimeline, cancelDeploymentPoolRequests, PoolAdminError
} from '../lib/windowsPool/admin.js';
import { createPoolRequest, reservePoolRequest } from '../lib/windowsPool/reservation.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;

test('Windows pool administration (P6)', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_adm_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 10 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, name TEXT, os_type TEXT, language TEXT, proxmox_template_vmid INT);
      CREATE TABLE lab_blueprints (id UUID PRIMARY KEY, name TEXT);
      CREATE TABLE classrooms (id UUID PRIMARY KEY, name TEXT);
      CREATE TABLE lab_deployments (id UUID PRIMARY KEY, status TEXT, deployment_number BIGINT, blueprint_id UUID, classroom_id UUID, last_job_id TEXT);`);
    for (const file of ['032-windows-pool.sql', '033-windows-pool-qualification.sql', '033-windows-pool-qualification.sql', '034-windows-pool-auto-placement.sql', '035-windows-pool-replacements.sql', '036-windows-pool-simplified-activation.sql', '037-windows-pool-global-placement.sql']) {
      await db.query(await fs.readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8')); // 033 replayed: idempotent
    }
    const tWin = randomUUID(), tLinux = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'Windows 2022 v2', 'windows-server', 'en', 147), ($2, 'Ubuntu', 'ubuntu', 'en', 111)`, [tWin, tLinux]);

    await t.test('unconfigured Windows template: identifier present in the overview (dev bug: templateId null)', async () => {
      const tpl = (await getPoolOverview(db)).templates.find(x => x.name === 'Windows 2022 v2');
      assert.equal(tpl.configured, false);
      assert.equal(tpl.templateId, tWin, 'the LEFT JOIN must not overwrite the template id with NULL');
    });

    await t.test('activation from VM Templates: first activation sets the pool storage, Windows only', async () => {
      // No pool storage yet and none deduced from the Proxmox template: refused with a clear message.
      await assert.rejects(setTemplatePool(db, tWin, { enabled: true, readyTarget: 3 }), error => error.code === 'NO_PLACEMENT' && error.status === 409);
      await assert.rejects(setTemplatePool(db, tLinux, { enabled: true, readyTarget: 1, storage: 'ceph-pool' }), error => error.code === 'NOT_WINDOWS');
      // Storage of the Proxmox template (given by the dashboard) -> becomes the pool storage.
      assert.deepEqual(await setTemplatePool(db, tWin, { enabled: true, readyTarget: 3, storage: 'ceph-pool' }), { created: true });
      const o = await getPoolOverview(db);
      assert.equal(o.settings.storage, 'ceph-pool');
      const tpl = o.templates.find(x => x.templateId === tWin);
      assert.deepEqual([tpl.configured, tpl.config.enabled, tpl.config.readyTarget, tpl.config.sourceTemplateVmid], [true, true, 3, 147], 'source = VMID of the template');
      assert.equal('node' in tpl.config || 'storage' in tpl.config || 'maxParallelPreparations' in tpl.config, false, 'no placement per template any more');
      assert.equal(o.templates.some(x => x.templateId === tLinux), false, 'Linux templates absent from the page');
      // Another storage given later does not replace the pool storage.
      await setTemplatePool(db, tWin, { enabled: true, readyTarget: 4, storage: 'other-store' });
      assert.equal((await getPoolOverview(db)).settings.storage, 'ceph-pool');
    });

    await t.test('VMID of the template: new revision kept enabled; no longer Windows: disabled', async () => {
      await db.query('UPDATE vm_templates SET proxmox_template_vmid = 160 WHERE id = $1', [tWin]);
      assert.deepEqual(await syncTemplateModel(db, tWin, { osType: 'windows-server', proxmoxTemplateVmid: 160 }), { newRevision: 2 });
      assert.deepEqual(await syncTemplateModel(db, tWin, { osType: 'windows-server', proxmoxTemplateVmid: 160 }), { newRevision: null }, 'same VMID: no change');
      let tpl = (await getPoolOverview(db)).templates.find(x => x.templateId === tWin);
      assert.deepEqual([tpl.config.revision, tpl.config.sourceTemplateVmid, tpl.config.enabled], [2, 160, true]);
      const tNew = randomUUID();
      await db.query(`INSERT INTO vm_templates VALUES ($1, 'Windows 11', 'windows11', 'fr', 148)`, [tNew]);
      assert.deepEqual(await setTemplatePool(db, tNew, { enabled: false, readyTarget: 0 }), { created: false }, 'disabling an unconfigured template: nothing');
      assert.deepEqual(await setTemplatePool(db, tNew, { enabled: true, readyTarget: 2 }), { created: true }, 'pool storage already set: nothing needed');
      tpl = (await getPoolOverview(db)).templates.find(x => x.templateId === tNew);
      assert.deepEqual([tpl.config.enabled, tpl.config.readyTarget, tpl.config.sourceTemplateVmid], [true, 2, 148]);
      await syncTemplateModel(db, tNew, { osType: 'ubuntu', proxmoxTemplateVmid: 148 });
      assert.equal((await db.query('SELECT enabled FROM windows_pool_templates WHERE template_id = $1', [tNew])).rows[0].enabled, false);
      await assert.rejects(setTemplatePool(db, tWin, { enabled: true, readyTarget: -1 }), error => error.code === 'VALIDATION');
    });

    await t.test('template deletion: pool history purged, refused while pool VMs live or are in labs', async () => {
      const tOld = randomUUID();
      await db.query(`INSERT INTO vm_templates VALUES ($1, 'Windows 2022 old', 'windows-server', 'en', 140)`, [tOld]);
      await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, source_template_vmid) VALUES ($1, false, 0, 1, 140)`, [tOld]);
      const vm = async (state, vmid) => {
        const id = randomUUID();
        await db.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state)
                        VALUES ($1, $2, 1, 140, 'default', 'pve-a', $3, $4)`, [id, tOld, vmid, state]);
        await db.query(`INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state) VALUES ($1, NULL, 'creating')`, [id]);
        return id;
      };
      const purge = async () => {
        const client = await db.connect();
        try { await client.query('BEGIN'); const result = await purgeTemplatePoolHistory(client, tOld); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      };
      await vm('deleted', 79001);
      await vm('deleted', 79002);
      const live = await vm('ready', 79003);
      await assert.rejects(purge(), error => error.code === 'POOL_IN_USE' && /1 pool VM/.test(error.message));
      // VM in a lab (assigned, then its row marked deleted after the lab): still refused.
      await db.query(`UPDATE windows_pool_vms SET state = 'deleted' WHERE id = $1`, [live]);
      const lab = randomUUID();
      await db.query(`INSERT INTO lab_deployments (id, status) VALUES ($1, 'running')`, [lab]);
      const assignment = randomUUID();
      await db.query(`INSERT INTO lab_vm_assignments (id, deployment_id, workstation_number, blueprint_vm_id, manager, cluster, vmid, pool_vm_id)
                      VALUES ($1, $2, 1, $3, 'windows-pool', 'default', 79003, $4)`, [assignment, lab, randomUUID(), live]);
      await assert.rejects(purge(), error => error.code === 'POOL_IN_USE' && /labs/.test(error.message));
      await db.query('DELETE FROM lab_vm_assignments WHERE id = $1', [assignment]);
      // History only: removed (VMs, journal, configuration), the template can then be deleted.
      assert.deepEqual(await purge(), { vms: 3, configuration: true });
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM windows_pool_vm_events e JOIN windows_pool_vms v ON v.id = e.pool_vm_id WHERE v.template_id = $1', [tOld])).rows[0].n, 0);
      await db.query('DELETE FROM vm_templates WHERE id = $1', [tOld]);
      assert.deepEqual(await purge(), { vms: 0, configuration: false }, 'template without pool history: nothing to do');
    });

    await t.test('settings and limits: validation, controlled suspension', async () => {
      await updatePoolSettings(db, { paused: false, proxmoxPool: 'labs-dev', dnsServers: ['195.186.4.162', '195.186.4.163'], maxCapacity: 30, node: 'peda-pve2', storage: 'ceph-pool', maxParallelPreparations: 6 });
      let settings = (await getPoolOverview(db)).settings;
      assert.deepEqual([settings.maxCapacity, settings.node, settings.storage, settings.maxParallelPreparations], [30, 'peda-pve2', 'ceph-pool', 6], 'global ceiling (036) and placement (037)');
      await updatePoolSettings(db, { node: '' });
      settings = (await getPoolOverview(db)).settings;
      assert.equal(settings.node, null, 'empty node = automatic placement');
      await assert.rejects(updatePoolSettings(db, { node: 'pve;x' }), error => error.code === 'VALIDATION');
      await assert.rejects(updatePoolSettings(db, { maxParallelPreparations: 0 }), error => error.code === 'VALIDATION');
      await assert.rejects(updatePoolSettings(db, { maxCapacity: 0 }), error => error.code === 'VALIDATION');
      await assert.rejects(updatePoolSettings(db, { dnsServers: ['not-an-ip'] }), error => error.code === 'VALIDATION');
      await assert.rejects(updatePoolSettings(db, { vmidMin: 1 }), error => error.code === 'VALIDATION', 'min and max go together, min >= 100');
      // VMID range (prod 80000-89999, dev 70000-79999: same Proxmox cluster).
      await assert.rejects(updatePoolSettings(db, { vmidMin: 55000, vmidMax: 64999 }), /Terraform labs/, 'overlap with the labs refused');
      await assert.rejects(updatePoolSettings(db, { vmidMin: 80000, vmidMax: 80010 }), /at least 100/);
      const live = (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted'`)).rows[0].n;
      assert.equal(live, 0, 'no pool VM yet in this test');
      await updatePoolSettings(db, { vmidMin: 80000, vmidMax: 89999 });
      assert.deepEqual([(await getPoolOverview(db)).settings.vmidMin, (await getPoolOverview(db)).settings.vmidMax], [80000, 89999]);
      const vmId = randomUUID();
      await db.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state)
                      SELECT $1, template_id, revision, source_template_vmid, 'default', 'pve-a', 80005, 'ready' FROM windows_pool_templates WHERE template_id = $2`, [vmId, tWin]);
      await assert.rejects(updatePoolSettings(db, { vmidMin: 70000, vmidMax: 79999 }), error => error.code === 'VMID_RANGE_IN_USE', 'live pool VM outside the new range');
      await db.query(`DELETE FROM windows_pool_vms WHERE id = $1`, [vmId]);
      await updatePoolSettings(db, { vmidMin: 70000, vmidMax: 79999 });
      await updateOperationLimit(db, { category: 'clone', scope: 'node:peda-pve2', maxActive: 1 });
      await assert.rejects(updateOperationLimit(db, { category: 'bogus', maxActive: 1 }), error => error.code === 'VALIDATION');
      const o = await getPoolOverview(db);
      assert.deepEqual([o.settings.paused, o.settings.proxmoxPool], [false, 'labs-dev']);
      assert.ok(o.limits.some(l => l.category === 'clone' && l.scope === 'node:peda-pve2' && l.maxActive === 1));
    });

    const addVm = async (state, extra = {}) => {
      const id = randomUUID();
      const vmid = 70000 + Math.floor(Math.random() * 9000);
      await db.query(`INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state, error_code, last_error, ready_at)
                      VALUES ($1, $2, 2, 160, 'default', 'peda-pve2', $3, $4, $5, $6, CASE WHEN $4 = 'ready' THEN NOW() END)`,
        [id, tWin, vmid, state, extra.errorCode ?? null, extra.lastError ?? null]);
      return { id, vmid };
    };

    await t.test('overview: counters per state, labs waiting with their missing needs, quarantine', async () => {
      await addVm('ready'); await addVm('preparing');
      const quarantined = await addVm('quarantined', { errorCode: 'BOOTSTRAP_ERRORS', lastError: 'errorCount=2' });
      const bp = randomUUID(), room = randomUUID(), lab = randomUUID();
      await db.query(`INSERT INTO lab_blueprints VALUES ($1, 'Win domain')`, [bp]);
      await db.query(`INSERT INTO classrooms VALUES ($1, 'A43')`, [room]);
      await db.query(`INSERT INTO lab_deployments VALUES ($1, 'waiting_for_pool', 42, $2, $3, NULL)`, [lab, bp, room]);
      const request = await createPoolRequest(db, { deploymentId: lab, kind: 'deploy', demand: [{ templateId: tWin, count: 3 }] });
      await reservePoolRequest(db, request.id);
      const o = await getPoolOverview(db);
      const tpl = o.templates.find(x => x.templateId === tWin);
      assert.deepEqual(tpl.counts, { ready: 1, preparing: 1, reserved: 0, assigned: 0, quarantined: 1, deleting: 0 });
      const r = o.requests.find(x => x.id === request.id);
      assert.deepEqual([r.blueprintName, r.classroomName, r.deploymentNumber, r.blockedReason], ['Win domain', 'A43', 42, 'INSUFFICIENT_STOCK']);
      assert.deepEqual(r.demand, [{ templateId: tWin, count: 3, readyNow: 1, missing: 2 }]);
      assert.deepEqual(o.quarantined.map(q => [q.vmid, q.errorCode]), [[quarantined.vmid, 'BOOTSTRAP_ERRORS']]);

      // Cancellation of the waiting lab (no reserved VM: no Proxmox call).
      const results = await cancelDeploymentPoolRequests({ db, proxmox: null, deploymentId: lab });
      assert.equal(results[0].status, 'cancelled');
      assert.equal((await getPoolOverview(db)).requests.length, 0);

      // Quarantine handled: destroyed (never returned to the stock), timeline traced.
      await destroyQuarantinedVm(db, quarantined.id);
      await assert.rejects(destroyQuarantinedVm(db, quarantined.id), error => error.code === 'NOT_QUARANTINED');
      const timeline = await getVmTimeline(db, quarantined.id);
      assert.deepEqual(timeline.events.map(e => [e.from, e.to, e.detail.code]), [['quarantined', 'deleting', 'QUARANTINE_RELEASED']]);
    });

    await t.test('metrics: preparation, assignment, and immediate wait vs empty stock never mixed', async () => {
      // Metrics only depend on the events ('assigned' without a request would be refused, rightly so, by the database).
      const vm = await addVm('deleted');
      await db.query(`INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail, created_at) VALUES
        ($1, 'preparing', 'ready', '{"preparationMs": 402000}', NOW() - interval '10 minutes'),
        ($1, 'reserved', 'configuring', '{}', NOW() - interval '5 minutes'),
        ($1, 'configuring', 'assigned', '{}', NOW() - interval '5 minutes' + interval '49 seconds')`, [vm.id]);
      const lab = randomUUID();
      await db.query(`INSERT INTO lab_deployments (id, status) VALUES ($1, 'deployed'), ($2, 'deployed')`, [lab, randomUUID()]);
      await db.query(`INSERT INTO windows_pool_requests (id, deployment_id, kind, demand, status, created_at, reserved_at) VALUES
        ($1, $3, 'deploy', '[{"templateId":"${tWin}","count":1}]', 'fulfilled', NOW() - interval '20 minutes', NOW() - interval '20 minutes' + interval '1 second'),
        ($2, $3, 'deploy', '[{"templateId":"${tWin}","count":1}]', 'fulfilled', NOW() - interval '15 minutes', NOW() - interval '15 minutes' + interval '403 seconds')`,
        [randomUUID(), randomUUID(), lab]);
      const m = (await getPoolOverview(db)).metrics;
      assert.deepEqual([m.preparation.count, m.preparation.p50Seconds], [1, 402]);
      assert.deepEqual([m.assignment.count, m.assignment.p50Seconds], [1, 49]);
      assert.equal(m.poolWait.count, 2);
      assert.deepEqual([m.poolWaitWhenStockEmpty.count, m.poolWaitWhenStockEmpty.p50Seconds], [1, 403], 'only the real wait');
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
