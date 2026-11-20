// Customization scheduling by dependencies (Windows pool lot P4d).
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCustomization, createLocalLimiter } from '../lib/runCustomization.js';
import { guestPasswordFor } from '../lib/ansibleTasks.js';
import { buildTaskInventory } from '../lib/runAnsibleTasks.js';

const jobMock = () => ({ data: { readinessFailedVmids: [] }, async updateData(data) { this.data = structuredClone(data); }, async updateProgress(p) { this.progress = structuredClone(p); } });
const block = id => ({ id, name: 'Block ' + id, yaml: '- name: noop\n  ansible.builtin.debug:\n    msg: ok\n' });

// Simulated Ansible: duration per (host, step); logs [t, 'start'|'end', label]; max concurrency.
function harness({ durations = {}, failOn = () => false } = {}) {
  const events = [];
  let active = 0;
  const stats = { maxActive: 0 };
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const runCommand = async (command, args) => {
    const host = args.includes('--limit') ? args[args.indexOf('--limit') + 1] : 'probe';
    const playbook = path.basename(args.find(a => a.endsWith('.yml')) ?? '');
    const tag = args.includes('--tags') ? args[args.indexOf('--tags') + 1] : (playbook.includes('domain') ? 'domain' : playbook.includes('linux') ? 'linux' : 'other');
    const label = `${host}:${tag}`;
    active += 1; stats.maxActive = Math.max(stats.maxActive, active);
    events.push([at(), 'start', label]);
    try {
      await sleep(durations[label] ?? durations[tag] ?? 20);
      if (failOn(label)) throw Object.assign(new Error('fatal: [x]: FAILED! ' + label), { stdout: 'fatal: [x]: FAILED! ' + label });
    } finally { active -= 1; events.push([at(), 'end', label]); }
  };
  const time = (kind, label) => events.find(e => e[1] === kind && e[2] === label)?.[0];
  return { events, stats, runCommand, time };
}

async function run(t, { windowsTargets = [], linuxTargets = [], h, job = jobMock(), limit, runTaskBlock = async () => ({ output: 'ok' }), reconnect = async () => {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { job, windowsTargets, linuxTargets, directory, inventoryPath: 'inventory.yml', extraVars: { windows_admin_password: 'pw', linux_default_username: 'u' },
    ansibleDir: 'ansible', runCommand: h.runCommand, reconnect, buildProbeInventory: () => '', probePlaybook: '', runTaskBlock, ...(limit && { limit }) };
  return { job, result: runCustomization(options) };
}
const win = (vmid, extra = {}) => ({ vmid, name: 'W' + vmid, stagedFileUploads: [], windowsAdminPassword: 'pw', ...extra });
const lin = (vmid, extra = {}) => ({ vmid, name: 'L' + vmid, ...extra });

test('Linux and Windows progress in parallel (no more "all Linux, then Windows")', async t => {
  const h = harness({ durations: { linux: 150, setup: 30 } });
  const { result } = await run(t, { windowsTargets: [win(1)], linuxTargets: [lin(2)], h });
  await result;
  assert.ok(h.time('start', 'vm_1:setup') < h.time('end', 'linux_vm_1:linux'), 'Windows setup starts before Linux ends');
});

test('domain member: waits for ITS controller only, not the other domains/workstations', async t => {
  // Workstation 1 (10.10.72.x, domain a.lab): slow controller. Workstation 2 (10.10.73.x): fast controller.
  const h = harness({ durations: { 'vm_1:domain': 400, domain: 20 } });
  const targets = [
    win(1, { domainRole: 'controller', domainName: 'a.lab', ipAddress: '10.10.72.10' }),
    win(2, { domainRole: 'member', domainName: 'a.lab', ipAddress: '10.10.72.11' }),
    win(3, { domainRole: 'controller', domainName: 'a.lab', ipAddress: '10.10.73.10' }),
    win(4, { domainRole: 'member', domainName: 'a.lab', ipAddress: '10.10.73.11' })
  ];
  const { result } = await run(t, { windowsTargets: targets, h });
  await result;
  assert.ok(h.time('start', 'vm_2:domain') >= h.time('end', 'vm_1:domain'), 'member of workstation 1 after its controller');
  assert.ok(h.time('start', 'vm_4:domain') >= h.time('end', 'vm_3:domain'), 'member of workstation 2 after its controller');
  assert.ok(h.time('end', 'vm_4:domain') < h.time('end', 'vm_1:domain'), 'workstation 2 does not wait for the slow controller of workstation 1');
});

test('controller failed: the member still attempts its join afterwards (semantics kept)', async t => {
  const h = harness({ failOn: label => label === 'vm_1:domain' });
  const targets = [
    win(1, { domainRole: 'controller', domainName: 'a.lab', ipAddress: '10.10.72.10' }),
    win(2, { domainRole: 'member', domainName: 'a.lab', ipAddress: '10.10.72.11' })
  ];
  const { result, job } = await run(t, { windowsTargets: targets, h });
  await assert.rejects(result, /W1/);
  assert.ok(h.time('start', 'vm_2:domain') >= h.time('end', 'vm_1:domain'));
  assert.equal(job.data.customizationResults[2].status, 'succeeded');
});

test('validation barrier: validations in parallel, one failure = no mutation, every failure recorded', async t => {
  const h = harness();
  let active = 0, maxActive = 0;
  const runTaskBlock = async ({ block, syntaxOnly }) => {
    assert.equal(syntaxOnly, true, 'no execution after a failed validation');
    active += 1; maxActive = Math.max(maxActive, active);
    await sleep(40); active -= 1;
    if (block.id !== 'ok') throw Object.assign(new Error('syntax error ' + block.id), { stdout: 'ERROR! syntax ' + block.id });
    return { output: '' };
  };
  const targets = [win(1, { ansibleTasks: [block('ok')] }), win(2, { ansibleTasks: [block('bad1')] }), lin(3, { ansibleTasks: [block('bad2')] })];
  const { result, job } = await run(t, { windowsTargets: targets.slice(0, 2), linuxTargets: [targets[2]], h, runTaskBlock });
  await assert.rejects(result, /syntax error/);
  assert.equal(h.events.length, 0, 'no Ansible playbook launched');
  assert.ok(maxActive >= 2, 'validations in parallel');
  assert.equal(job.data.customizationResults[2].status, 'failed');
  assert.equal(job.data.customizationResults[3].status, 'failed', 'every invalid block recorded, not only the first one');
});

test('preparation failure: no fault injection anywhere (barrier kept)', async t => {
  const h = harness({ failOn: label => label === 'vm_2:setup' });
  const executed = [];
  const runTaskBlock = async ({ block, syntaxOnly }) => { if (!syntaxOnly) executed.push(block.id); return { output: 'ok' }; };
  const { result } = await run(t, { windowsTargets: [win(1, { ansibleTasks: [block('inject')] }), win(2)], h, runTaskBlock });
  await assert.rejects(result, /W2/);
  assert.deepEqual(executed, []);
});

test('limit: only the Ansible commands hold a slot, never the reconnect waits', async t => {
  const h = harness({ durations: { setup: 40, reboot: 10 } });
  let reconnecting = 0, maxReconnecting = 0;
  const reconnect = async () => { reconnecting += 1; maxReconnecting = Math.max(maxReconnecting, reconnecting); await sleep(150); reconnecting -= 1; };
  const targets = [1, 2, 3, 4, 5].map(vmid => win(vmid));
  const { result } = await run(t, { windowsTargets: targets, h, limit: createLocalLimiter(2), reconnect });
  await result;
  assert.equal(h.stats.maxActive, 2, 'limit 2 reached, never exceeded');
  assert.ok(maxReconnecting >= 3, `reconnects (waits) beyond the limit: ${maxReconnecting}`);
});

test('task blocks: run in parallel across VMs after the barrier, in order within a VM', async t => {
  const h = harness();
  const order = [];
  let active = 0, maxActive = 0;
  const runTaskBlock = async ({ block, target, syntaxOnly }) => {
    if (syntaxOnly) return { output: '' };
    active += 1; maxActive = Math.max(maxActive, active);
    order.push(`${target.vmid}:${block.id}`);
    await sleep(30); active -= 1;
    return { output: 'ok' };
  };
  const { result, job } = await run(t, { windowsTargets: [win(1, { ansibleTasks: [block('a1'), block('a2')] }), win(2, { ansibleTasks: [block('b1')] })], h, runTaskBlock });
  await result;
  assert.ok(maxActive >= 2);
  assert.ok(order.indexOf('1:a1') < order.indexOf('1:a2'));
  assert.ok(Object.values(job.data.customizationResults).every(r => r.status === 'succeeded'));
});

// --- Passwords of the task blocks ---------------------------------------------------------

test('guest password: the VM\'s own if not empty, otherwise the shared one (never empty by mistake)', () => {
  assert.equal(guestPasswordFor({ windowsAdminPassword: 'Ws02!pass' }, 'Shared!1'), 'Ws02!pass');
  assert.equal(guestPasswordFor({ windowsAdminPassword: '' }, 'Shared!1'), 'Shared!1', 'empty string -> shared password (bug of the `??` rule)');
  assert.equal(guestPasswordFor({ windowsAdminPassword: '   ' }, 'Shared!1'), 'Shared!1');
  assert.equal(guestPasswordFor({}, 'Shared!1'), 'Shared!1');
  assert.equal(guestPasswordFor(null, undefined), '');
  const inventory = buildTaskInventory({ target: { osType: 'windows-server', ipAddress: '10.0.0.5', windowsAdminPassword: '' }, password: 'Shared!1' });
  assert.equal(inventory.all.hosts.target.ansible_password, 'Shared!1');
  const linux = buildTaskInventory({ target: { osType: 'ubuntu', ipAddress: '10.0.0.6', windowsAdminPassword: 'Ws03!pass' }, password: 'Shared!1', linuxUser: 'emf' });
  assert.deepEqual([linux.all.hosts.target.ansible_password, linux.all.hosts.target.ansible_become_password], ['Ws03!pass', 'Ws03!pass']);
});

test('task blocks: each VM receives ITS password (per-workstation mode), shared one if absent', async t => {
  const h = harness();
  const received = {};
  const runTaskBlock = async ({ target, password, syntaxOnly }) => { if (!syntaxOnly) received[target.vmid] = password; return { output: 'ok' }; };
  const targets = [
    win(1, { windowsAdminPassword: 'Ws01!pass', ansibleTasks: [block('a')] }),
    win(2, { windowsAdminPassword: 'Ws02!pass', ansibleTasks: [block('b')] }),
    win(3, { windowsAdminPassword: '', ansibleTasks: [block('c')] })
  ];
  const { result } = await run(t, { windowsTargets: targets, h, runTaskBlock });
  await result;
  assert.deepEqual(received, { 1: 'Ws01!pass', 2: 'Ws02!pass', 3: 'pw' }, 'pw = shared password of the lab (extraVars)');
});
