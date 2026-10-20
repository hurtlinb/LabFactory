import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DelayedError } from 'bullmq';
import { acquireJobLocks, tryJobLocks, recoverDeploymentJobs, workerConcurrency } from '../lib/jobConcurrency.js';
import { createTerraformJobDirectory } from '../lib/terraformJobDirectory.js';

function lockPool() {
  const locks = new Map(), clients = [];
  return {
    locks, clients,
    async connect() {
      const client = new EventEmitter();
      client.query = async ({ values }) => {
        if (!values) return { rows: [{}] };
        const key = values[1];
        if (locks.has(key) && locks.get(key) !== client) return { rows: [{ acquired: false }] };
        locks.set(key, client);
        return { rows: [{ acquired: true }] };
      };
      client.release = destroy => {
        assert.equal(destroy, true);
        for (const [key, owner] of locks) if (owner === client) locks.delete(key);
      };
      clients.push(client);
      return client;
    }
  };
}
const jobFor = (id, action = 'start') => ({
  id: `${id}-${action}`, data: { labInstanceId: id, deploymentId: id, action, runId: `run-${id}`, blueprint: { vms: [] } },
  async updateData(data) { this.data = data; },
  async updateProgress(progress) { this.progress = progress; },
  async moveToDelayed(timestamp, token) { this.delayed = { timestamp, token }; }
});

test('only one deploy runs, while start/stop on other labs acquire slots immediately', async () => {
  const pool = lockPool(), controller = new AbortController();
  const first = await acquireJobLocks(pool, jobFor('a', 'deploy'), 'a', controller, { deploy: true });
  const secondJob = jobFor('b', 'deploy');
  await assert.rejects(acquireJobLocks(pool, secondJob, 'token-b', controller, { deploy: true }), DelayedError);
  assert.equal(secondJob.delayed.token, 'token-b');
  const start = await acquireJobLocks(pool, jobFor('b'), 'start', controller);
  const stop = await acquireJobLocks(pool, jobFor('c', 'stop'), 'stop', controller);
  await first.release(); await start.release(); await stop.release();
  const next = await acquireJobLocks(pool, secondJob, 'b', controller, { deploy: true });
  await next.release(); assert.equal(pool.locks.size, 0);
});

test('Terraform and Ansible cannot operate on the same lab and contention releases partial locks', async () => {
  const pool = lockPool();
  const ansible = await acquireJobLocks(pool, { data: { deploymentId: 'a' } }, 'ansible');
  await assert.rejects(acquireJobLocks(pool, jobFor('a', 'deploy'), 'deploy', null, { deploy: true }), DelayedError);
  assert.equal(pool.locks.has('global:terraform-deploy'), false);
  const other = await acquireJobLocks(pool, jobFor('b', 'deploy'), 'other', null, { deploy: true });
  await other.release(); await ansible.release();
});

test('lost lock connection aborts work and rejects successful completion', async () => {
  const pool = lockPool(), controller = new AbortController();
  const lease = await tryJobLocks(pool, ['lab:a'], controller);
  pool.clients[0].emit('error', new Error('Connection lost'));
  assert.equal(controller.signal.aborted, true);
  assert.throws(() => lease.assertHeld(), /Connection lost/);
  await lease.release(); await lease.release();
});

test('restart recovery preserves queued, delayed and executing jobs', async () => {
  const pool = lockPool(), updates = [];
  const rows = ['waiting', 'delayed', 'active', 'failed', 'missing', 'locked'].map(id => ({ id, status: 'queued', last_job_id: id, last_run_id: id }));
  pool.query = async (sql, args) => {
    if (sql.startsWith('SELECT')) return { rows };
    updates.push(args[0]); return { rowCount: 1 };
  };
  const held = await tryJobLocks(pool, ['lab:locked']);
  const count = await recoverDeploymentJobs(pool, { getJob: async id => id === 'missing' ? null : { getState: async () => id } }, ['queued'], 'worker-restarted');
  assert.equal(count, 2); assert.deepEqual(updates, ['failed', 'missing']);
  await held.release();
});

test('job directories copy config and provider lockfile, never previous plans, secrets or state', async t => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-source-test-'));
  const directories = [source];
  t.after(async () => { for (const directory of directories) await fs.rm(directory, { recursive: true, force: true }); });
  for (const name of ['main.tf', '.terraform.lock.hcl', 'tfplan', '.terraform-vars.json', 'terraform.tfstate']) await fs.writeFile(path.join(source, name), name);
  await fs.mkdir(path.join(source, '.terraform'));
  const [a, b] = await Promise.all([createTerraformJobDirectory(source), createTerraformJobDirectory(source)]);
  directories.push(a, b);
  assert.notEqual(a, b);
  assert.deepEqual((await fs.readdir(a)).sort(), ['.terraform.lock.hcl', 'main.tf']);
  await fs.writeFile(path.join(a, 'tfplan'), 'lab-a');
  await assert.rejects(fs.readFile(path.join(b, 'tfplan')), { code: 'ENOENT' });
  assert.match(await fs.readFile('terraform/main.tf', 'utf8'), /backend "pg"/);
});

test('concurrency configuration is bounded', () => {
  assert.equal(workerConcurrency(undefined, 4), 4);
  assert.equal(workerConcurrency('2', 4), 2);
  for (const value of ['0', '-1', '9', '1.5', 'abc']) assert.throws(() => workerConcurrency(value, 4));
});

test('Terraform processor runs start and stop concurrently, defers deploy contention and keeps workspace identity', async t => {
  const pool = lockPool(), transitions = [], commands = [], directories = [];
  const source = await fs.readFile('workers/terraformWorker.js', 'utf8');
  let processor, options;
  let waiting = 0, releasePower;
  const powerGate = new Promise(resolve => { releasePower = resolve; });
  const sandbox = {
    Worker: class { constructor(_name, fn, config) { processor = fn; options = config; } on() {} async close() {} },
    Queue: class { async add() { return { id: 'child' }; } },
    terraformQueueName: 'tf', ansibleQueueName: 'ansible', dbPool: pool,
    AbortController, DelayedError, acquireJobLocks, workerConcurrency, setMaxListeners() {},
    setInterval: () => ({ unref() {} }), clearInterval() {},
    fetchProxmoxVmResources: async () => [],
    claimPoolVms: async (_db, _id, vms) => ({ vms, waiting: [] }),
    process: { env: {} }, path, console: { log() {}, warn() {}, error() {} },
    terraformSourceDir: path.resolve('terraform'), terraformVarsPath: 'config.json',
    createTerraformJobDirectory: async source => { const dir = await createTerraformJobDirectory(source); directories.push(dir); return dir; },
    readFile: async () => '{}', writeFile: fs.writeFile, rm: fs.rm,
    createDeploymentReadinessReporter: () => ({ publish: async () => {}, markStartedAll: async () => {} }),
    workspaceNameFor: id => `blueprint-${id}`, resolveTerraformParallelism: () => 10,
    normalizeVmids: () => [], buildTerraformReplaceArgs: () => [], buildTerraformTargetArgs: () => [],
    safeUpdateLifecycleStatus: async (id, status) => { transitions.push([id, status]); return true; },
    sanitizeSettingsInput: value => value, readTerraformEnvSettings: () => ({}), defaultTerraformSettings: {},
    assertRequiredTerraformEnvSettings() {}, resolveProxmoxTargetNodes: async () => [],
    resolveVmNodesByVmid: async () => new Map(), runWithConcurrency: async () => {},
    waitForVmPowerState: async () => { waiting++; await powerGate; return true; },
    waitForGuestReadiness: async () => ({ readyVmids: new Set(), failedVmids: new Set() }),
    STOP_STATE_CONFIRMATION_TIMEOUT_MS: 10,
    runCommand: async (_command, args, opts) => { commands.push({ args, ...opts }); return ''; }
  };
  t.after(async () => { releasePower(); for (const dir of directories) await fs.rm(dir, { recursive: true, force: true }); });
  vm.runInNewContext(source.slice(source.indexOf('export function startTerraformWorker'), source.indexOf('export async function resetStalledTerraformDeployments')).replace('export function', 'function') + '\nstartTerraformWorker({});', sandbox);
  assert.equal(options.concurrency, 4);
  const global = await tryJobLocks(pool, ['global:terraform-deploy']);
  const blocked = jobFor('d', 'deploy');
  await assert.rejects(processor(blocked, 'token'), DelayedError);
  assert.deepEqual(transitions, []);
  const start = processor(jobFor('a'), 'a'), stop = processor(jobFor('b', 'stop'), 'b');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(timer); reject(Error('Power jobs did not overlap')); }, 3000);
    const timer = setInterval(() => { if (waiting === 2) { clearTimeout(timeout); clearInterval(timer); resolve(); } }, 5);
  });
  releasePower(); await Promise.all([start, stop]); await global.release();
  assert(transitions.some(([id, status]) => id === 'a' && status === 'running'));
  assert(transitions.some(([id, status]) => id === 'b' && status === 'stopped'));
  await processor(jobFor('d', 'deploy'), 'd');
  assert(commands.some(({ args }) => args.join(' ') === 'workspace select blueprint-d'));
  assert(commands.every(({ cwd, env }) => env.TF_DATA_DIR === path.join(cwd, '.terraform')));
  const commandCount = commands.length;
  sandbox.claimPoolVms = async (_db, _id, vms) => ({ vms, waiting: ['pending-vm'] });
  const poolWaiting = jobFor('pool', 'deploy');
  await assert.rejects(processor(poolWaiting, 'pool-token'), DelayedError);
  assert.equal(poolWaiting.progress.type, 'pool-wait');
  assert.equal(poolWaiting.progress.waitingCount, 1);
  assert.equal(poolWaiting.delayed.token, 'pool-token');
  assert.equal(commands.length, commandCount, 'no Terraform clone while waiting for pool');
  assert.equal(pool.locks.size, 0, 'replenishment can acquire the deployment lock');
  assert(!transitions.some(([id, status]) => id === 'pool' && status === 'failed'));
  sandbox.claimPoolVms = async (_db, _id, vms) => ({ vms, waiting: [] });
  sandbox.runCommand = async () => { throw new Error('Terraform failed'); };
  await assert.rejects(processor(jobFor('failed', 'deploy'), 'failed'), /Terraform failed/);
  assert(transitions.some(([id, status]) => id === 'failed' && status === 'failed'));
  for (const dir of directories) await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  assert.equal(pool.locks.size, 0);
});

test('Ansible processor shares the lab lock with Terraform and releases it after failure', async () => {
  const pool = lockPool(), transitions = [];
  const source = await fs.readFile('workers/ansibleWorker.js', 'utf8');
  let processor, options;
  const sandbox = {
    Worker: class { constructor(_name, fn, config) { processor = fn; options = config; } on() {} },
    Queue: class {}, ansibleQueueName: 'ansible', dbPool: pool,
    AbortController, DelayedError, acquireJobLocks, workerConcurrency,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    activeAnsibleTasks: () => [], getFileUploads: () => [],
    safeUpdateDeploymentStatus: async (id, status) => { transitions.push([id, status]); return true; }
  };
  vm.runInNewContext(source.slice(source.indexOf('export function startAnsibleWorker'), source.indexOf('export async function resetStalledAnsibleDeployments')).replace('export function', 'function') + '\nstartAnsibleWorker({});', sandbox);
  assert.equal(options.concurrency, 2);
  const held = await tryJobLocks(pool, ['lab:a']);
  const job = jobFor('a');
  job.name = 'customize-timezone';
  await assert.rejects(processor(job, 'token'), DelayedError);
  assert.deepEqual(transitions, []);
  await held.release();
  await processor(job, 'token');
  assert.deepEqual(transitions, [['a', 'deployed']]);
  job.data.windowsAdminPassword = 'mismatched';
  await assert.rejects(processor(job, 'token'), /password does not match/);
  assert.equal(pool.locks.size, 0);
});
