import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { retryConnectionOperation, isTransientConnectionError, commandFailure } from '../lib/customizationRecovery.js';
import { runCustomization } from '../lib/runCustomization.js';

test('transient copy failure waits progressively and probes before retrying', async () => {
  const events = [];
  let calls = 0;
  await retryConnectionOperation({
    run: async () => { events.push('copy'); if (++calls < 4) throw new Error('ConnectTimeoutError'); },
    probe: async () => { events.push('ping'); },
    report: async () => {}, sleep: async ms => events.push(ms)
  });
  assert.deepEqual(events, ['copy', 15000, 'ping', 'copy', 30000, 'ping', 'copy', 60000, 'ping', 'copy']);
});

test('failed probes do not copy and retries are bounded', async () => {
  let copies = 0, probes = 0;
  const reports = [];
  await assert.rejects(retryConnectionOperation({
    run: async () => { copies++; throw new Error('Connection reset'); },
    probe: async () => { probes++; throw new Error('Connection refused'); },
    report: async value => reports.push(value), sleep: async () => {}
  }), /Connection refused/);
  assert.equal(copies, 1); assert.equal(probes, 3);
  assert.equal(reports.at(-1).attempt, 4);
  assert.equal(reports.at(-1).status, 'failed');
});

test('permanent errors fail immediately and abort interrupts a retry', async () => {
  for (const message of ['Access denied', 'invalid credentials', 'not enough space on disk', 'syntax error']) {
    assert.equal(isTransientConnectionError(message), false);
    await assert.rejects(retryConnectionOperation({
      run: async () => { throw new Error(message); }, report: async () => {},
      probe: () => assert.fail('must not probe'), sleep: () => assert.fail('must not wait')
    }), { message });
  }
  const controller = new AbortController();
  await assert.rejects(retryConnectionOperation({
    signal: controller.signal, run: async () => { throw new Error('ConnectTimeoutError'); },
    report: async () => {}, probe: () => assert.fail('cancelled'),
    sleep: async () => controller.abort(new Error('cancelled'))
  }), /cancelled/);
});

test('diagnostic uses the actual Ansible failure without command arguments', () => {
  const error = Object.assign(new Error('command secret-password'), { stdout: 'TASK [Copy]\nfatal: [vm_4]: FAILED! => {"msg":"Connection reset"}\nPLAY RECAP\n' });
  assert.equal(commandFailure(error), 'fatal: [vm_4]: FAILED! => {"msg":"Connection reset"}');
});

function jobMock() {
  return { data: {}, async updateData(data) { this.data = structuredClone(data); }, async updateProgress(progress) { this.progress = structuredClone(progress); } };
}

test('partial failure retains successful VMs and files; resume executes only remaining steps', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'customization-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const job = jobMock();
  const windowsTargets = [1, 2].map(vmid => ({ vmid, name: 'VM ' + vmid, stagedFileUploads: [
    { source: 'source-a', destination: 'C:\\Install\\a.exe', directory: 'C:\\Install' },
    { source: 'source-b', destination: 'C:\\Install\\b.exe', directory: 'C:\\Install' }
  ] }));
  const calls = []; let failing = true;
  const options = {
    job, windowsTargets, linuxTargets: [], directory, inventoryPath: 'inventory.yml',
    extraVars: { windows_admin_password: 'secret-password' }, ansibleDir: 'ansible',
    reconnect: async ({ target }) => calls.push('reconnect:' + target.vmid),
    runCommand: async (command, args) => {
      assert(!args.join(' ').includes('secret-password'));
      const host = args[args.indexOf('--limit') + 1];
      const tags = args[args.indexOf('--tags') + 1];
      const file = tags === 'files' ? JSON.parse(await fs.readFile(args.at(-1).slice(1))).file_uploads[0].destination : '';
      calls.push(host + ':' + tags + ':' + file);
      if (failing && host === 'vm_2' && file.endsWith('b.exe')) throw new Error('Access denied');
    }
  };
  await assert.rejects(runCustomization(options), /VM 2.*b.exe.*Access denied/);
  assert.deepEqual(job.progress.reconnectedVmids, [1]);
  assert.deepEqual(job.progress.failedVmids, [2]);
  assert(job.data.customizationResults[2].completedSteps.includes('copy: C:\\Install\\a.exe'));
  failing = false; calls.length = 0;
  await runCustomization(options);
  assert.deepEqual(calls, ['vm_2:files:C:\\Install\\b.exe', 'vm_2:reboot:', 'reconnect:2']);
  assert.equal(job.progress.results.filter(r => r.status === 'succeeded').length, 2);
});

test('reconnect failure cannot report success; resume does not reboot again', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'customization-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const job = jobMock(); let failed = true; const calls = [];
  const options = { job, windowsTargets: [{ vmid: 1, name: 'VM', stagedFileUploads: [] }], linuxTargets: [], directory,
    inventoryPath: 'inventory.yml', extraVars: {}, ansibleDir: 'ansible', runCommand: async () => calls.push('command'),
    reconnect: async () => { calls.push('reconnect'); if (failed) throw new Error('ConnectTimeoutError'); } };
  await assert.rejects(runCustomization(options), /reconnect/);
  assert.deepEqual(job.progress.failedVmids, [1]);
  failed = false; calls.length = 0; await runCustomization(options);
  assert.deepEqual(calls, ['reconnect']);
});

test('resume endpoint rejects unauthorized, stale and legacy jobs and rolls back queue failures', async () => {
  const source = await fs.readFile('dashboard/server.js', 'utf8');
  const start = source.indexOf("app.post(\n  '/api/lifecycle/deployments/:id/resume-customization'");
  const end = source.indexOf("app.post(\n  '/api/lifecycle/deployments/:id/:action'", start);
  async function request({ manage = true, runId = 'run', checkpoints = {}, retryError = false, claim = 1 } = {}) {
    let handler, retries = 0; const queries = [];
    const deployment = { id: 'lab', status: 'failed', lastAction: 'customize', lastJobId: '37', lastRunId: 'run' };
    const context = { app: { post: (route, auth, fn) => { handler = fn; } }, auth: { requireRole: () => {}, ROLE_GROUPS: {} }, wrapAsync: fn => fn,
      fetchDeploymentById: async () => deployment, canManageDeployment: () => manage,
      denyDeploymentManagement: res => res.status(403).json({}),
      queues: { ansible: { getJob: async () => ({ id: '37', getState: async () => 'failed', data: { runId, deploymentId: 'lab', customizationResults: checkpoints }, retry: async () => { retries++; if (retryError) throw Error('Redis unavailable'); } }) } },
      dbPool: { query: async (...args) => { queries.push(args); return { rowCount: claim }; } } };
    vm.runInNewContext(source.slice(start, end), context);
    const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    let error; try { await handler({ params: { id: 'lab' } }, response); } catch (err) { error = err; }
    return { response, retries, queries, error };
  }
  assert.equal((await request({ manage: false })).response.code, 403);
  assert.equal((await request({ runId: 'old' })).response.code, 409);
  assert.equal((await request({ checkpoints: null })).response.code, 409);
  assert.equal((await request({ claim: 0 })).retries, 0);
  assert.equal((await request()).retries, 1);
  const rollback = await request({ retryError: true });
  assert.equal(rollback.queries.length, 2); assert.match(rollback.error.message, /Redis/);
});

test('lab card shows partial success and exposes resume only when eligible', async () => {
  const source = await fs.readFile('dashboard/public/app.js', 'utf8');
  const code = source.slice(source.indexOf('function renderLifecycleLabs()'), source.indexOf('function renderDashboard()'));
  const deployment = { id: 'lab', deploymentNumber: 51, status: 'failed', blueprint: { name: 'Test' }, classroom: { name: 'Room' }, canResumeCustomization: true,
    customizationResults: Array.from({ length: 22 }, (_, i) => ({ status: i === 3 ? 'failed' : 'succeeded' })) };
  const list = { innerHTML: '', querySelectorAll: () => [] };
  const context = { lifecycleList: list, state: { deployments: [deployment] }, syncLabVisibilityToggle: () => {},
    getVisibleLifecycleDeployments: () => [deployment], resolveLifecycleActions: () => ({ items: [] }),
    canManageDeployment: () => true, isForeignDeployment: () => false, escapeHtml: String,
    renderTeacherBadge: () => '', renderLifecycleSteps: () => '',
    labStatusLabel: value => value };
  vm.runInNewContext(source.slice(source.indexOf('const UI_ICONS ='), source.indexOf('const state =')), context);
  vm.runInNewContext(code + '\nrenderLifecycleLabs();', context);
  assert.match(list.innerHTML, /21 customized, 1 failed, 0 pending/);
  assert.match(list.innerHTML, /data-action="resume-customization"/);
  deployment.canResumeCustomization = false;
  vm.runInNewContext('renderLifecycleLabs();', context);
  assert.doesNotMatch(list.innerHTML, /data-action="resume-customization"/);
});
