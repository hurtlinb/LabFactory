// Windows pool administration (P6): real PostgreSQL (isolated schema). Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  getPoolOverview, updatePoolSettings, configureTemplate, qualifyTemplate, setTemplateEnabled,
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
    for (const file of ['032-windows-pool.sql', '033-windows-pool-qualification.sql', '033-windows-pool-qualification.sql']) {
      await db.query(await fs.readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8')); // 033 replayed: idempotent
    }
    const tWin = randomUUID(), tLinux = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'Windows 2022 v2', 'windows-server', 'en', 147), ($2, 'Ubuntu', 'ubuntu', 'en', 111)`, [tWin, tLinux]);
    const config = { readyTarget: 2, maxCapacity: 4, maxParallelPreparations: 2, node: 'peda-pve2', storage: 'ceph-pool', sourceTemplateVmid: 147 };

    await t.test('configuration: Windows only, strict validation, created disabled', async () => {
      await assert.rejects(configureTemplate(db, tLinux, config), error => error.code === 'NOT_WINDOWS');
      await assert.rejects(configureTemplate(db, tWin, { ...config, readyTarget: 9 }), error => error instanceof PoolAdminError && /maximum capacity/.test(error.message));
      await assert.rejects(configureTemplate(db, tWin, { ...config, node: 'pve;x' }), error => error.code === 'VALIDATION');
      await assert.rejects(configureTemplate(db, tWin, { ...config, enabled: true }), error => error.code === 'VALIDATION', 'enabled is not set through this route');
      assert.deepEqual(await configureTemplate(db, tWin, config), { created: true, newRevision: false });
      const tpl = (await getPoolOverview(db)).templates.find(x => x.templateId === tWin);
      assert.deepEqual([tpl.configured, tpl.config.enabled, tpl.config.qualified], [true, false, false]);
      assert.equal((await getPoolOverview(db)).templates.some(x => x.templateId === tLinux), false, 'Linux templates absent from the page');
    });

    await t.test('activation: refused without qualification, allowed after, a new revision requires requalification', async () => {
      await assert.rejects(setTemplateEnabled(db, tWin, true), error => error.code === 'NOT_QUALIFIED' && error.status === 409);
      await qualifyTemplate(db, tWin, { actor: 'admin@test', note: 'P0 + e2e dev' });
      await setTemplateEnabled(db, tWin, true);
      let tpl = (await getPoolOverview(db)).templates.find(x => x.templateId === tWin);
      assert.deepEqual([tpl.config.enabled, tpl.config.qualified, tpl.config.qualifiedBy, tpl.config.qualificationNote], [true, true, 'admin@test', 'P0 + e2e dev']);
      // Same source template: no revision change, stays enabled.
      assert.deepEqual(await configureTemplate(db, tWin, { ...config, readyTarget: 3 }), { created: false, newRevision: false });
      assert.equal((await getPoolOverview(db)).templates.find(x => x.templateId === tWin).config.enabled, true);
      // New Proxmox source template: new revision, disabled, not qualified.
      assert.deepEqual(await configureTemplate(db, tWin, { ...config, sourceTemplateVmid: 160 }), { created: false, newRevision: true });
      tpl = (await getPoolOverview(db)).templates.find(x => x.templateId === tWin);
      assert.deepEqual([tpl.config.revision, tpl.config.enabled, tpl.config.qualified], [2, false, false]);
      await assert.rejects(setTemplateEnabled(db, tWin, true), error => error.code === 'NOT_QUALIFIED');
      // Direct bypass forbidden by the database itself.
      await assert.rejects(db.query('UPDATE windows_pool_templates SET enabled = true WHERE template_id = $1', [tWin]), /enabled_qualified/);
      await qualifyTemplate(db, tWin, { actor: 'admin@test' });
      await setTemplateEnabled(db, tWin, true);
    });

    await t.test('settings and limits: validation, controlled suspension', async () => {
      await updatePoolSettings(db, { paused: false, proxmoxPool: 'labs-dev', dnsServers: ['195.186.4.162', '195.186.4.163'] });
      await assert.rejects(updatePoolSettings(db, { dnsServers: ['not-an-ip'] }), error => error.code === 'VALIDATION');
      await assert.rejects(updatePoolSettings(db, { vmidMin: 1 }), error => error.code === 'VALIDATION', 'VMID range not editable');
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
