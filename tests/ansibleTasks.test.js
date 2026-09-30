import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateTaskBlock, getAnsibleTasks, taskCheckpoint, customPlaybook } from '../lib/ansibleTasks.js';
import { runAnsibleTaskBlock } from '../lib/runAnsibleTasks.js';
import { runCustomization } from '../lib/runCustomization.js';

const block = (id = 'one', yaml = 'tasks:\n  - name: Hello\n    ansible.builtin.debug:\n      msg: Hello') => ({ id, name: id, yaml, variables: {} });

test('accepts DNS, ACL and Docker examples, preserving intended faults and Windows paths', () => {
  for (const yaml of [
    'tasks:\n  - ansible.windows.win_dns_record:\n      zone: alpinatech.local\n      name: files\n      type: CNAME\n      value: srv1.alpintech.local\n      state: present',
    "- ansible.windows.win_acl:\n    path: '{{ share_root }}\\Projects'\n    user: 'ALPINATECH\\DL-Projects-RW'\n    rights: Modify\n    type: allow\n    state: absent",
    '- community.docker.docker_container:\n    name: web2\n    image: nginx:latest\n    state: started\n    ports: ["80:80"]'
  ]) {
    const input = { ...block('example', yaml), variables: { share_root: 'C:\\Shares' } };
    assert.equal(validateTaskBlock(input).tasks.length, 1);
    assert.equal(JSON.parse(customPlaybook(input))[0].hosts, 'target');
  }
});

test('rejects duplicate YAML keys, full plays, unsupported features and missing collections', () => {
  for (const yaml of [
    'tasks: []\ntasks: []', '- hosts: all\n  tasks: []',
    '- debug: {msg: hello}', '- vendor.missing.task: {}',
    '- ansible.builtin.debug: {}\n  delegate_to: localhost',
    '- ansible.builtin.import_tasks: /etc/passwd',
    '- ansible.builtin.debug: {}\n  async: 30',
    '- ansible.builtin.debug: {}\n  vars: {ansible_host: another-vm}',
    '- ansible.builtin.debug: {}\n  register: ansible_password',
    '- block:\n    - ansible.builtin.include_role: {name: external}',
    'tasks: &tasks [*tasks]'
  ]) assert.throws(() => validateTaskBlock(block('invalid', yaml)), { code: 'VALIDATION' }, yaml);
  assert.throws(() => getAnsibleTasks({ ansibleTasks: [block(), block()] }), /Duplicate/);
  assert.throws(() => validateTaskBlock({ ...block(), variables: { ansible_password: 'override' } }), /Reserved/);
});

test('checkpoint changes with tasks and variables but not block display name', () => {
  assert.equal(taskCheckpoint(block()), taskCheckpoint({ ...block(), name: 'Renamed' }));
  assert.notEqual(taskCheckpoint(block()), taskCheckpoint({ ...block(), variables: { x: 1 } }));
  assert.notEqual(taskCheckpoint(block()), taskCheckpoint(block('one', '- ansible.builtin.debug: {msg: Changed}')));
});

async function setup(t, { windowsTargets = [], linuxTargets = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-tasks-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [];
  const job = { data: {}, async updateData(data) { this.data = structuredClone(data); }, async updateProgress() {} };
  return { events, job, options: {
    job, windowsTargets, linuxTargets, directory, inventoryPath: 'inventory', extraVars: {}, ansibleDir: 'ansible',
    reconnect: async ({ target }) => events.push(`reconnect:${target.vmid}`),
    runCommand: async (_, args) => events.push(`${path.basename(args[0])}:${args[args.indexOf('--limit') + 1]}`),
    runTaskBlock: async ({ block, target, syntaxOnly }) => {
      events.push(`${syntaxOnly ? 'validate' : 'custom'}:${target.vmid}:${block.id}`);
      return { output: 'ok', image: 'test' };
    }
  } };
}

test('global barrier waits for Linux, Windows, reconnect, controller and member; blocks are ordered', async t => {
  const linuxTargets = [{ vmid: 1, name: 'linux', ansibleTasks: [block('first'), block('second')] }];
  const windowsTargets = [
    { vmid: 2, name: 'DC', domainRole: 'controller', stagedFileUploads: [], ansibleTasks: [block()] },
    { vmid: 3, name: 'Member', domainRole: 'member', stagedFileUploads: [] }
  ];
  const { events, options, job } = await setup(t, { linuxTargets, windowsTargets });
  await runCustomization(options);
  const customIndex = events.findIndex(event => event.startsWith('custom:'));
  assert(customIndex > events.lastIndexOf('windows-domain-playbook.yml:vm_2'));
  assert(events.indexOf('custom:1:second') > events.indexOf('custom:1:first'));
  assert(Object.values(job.data.customizationResults).every(record => record.status === 'succeeded'));
  assert.equal(job.data.customizationResults[1].taskResults.first.status, 'succeeded');
});

test('standard failure blocks every custom task and resume keeps completed standard steps', async t => {
  const { options, events } = await setup(t, { linuxTargets: [1, 2].map(vmid => ({ vmid, name: `VM ${vmid}`, ansibleTasks: [block()] })) });
  const execute = options.runCommand;
  options.runCommand = async (...args) => { await execute(...args); if (args[1].includes('linux_vm_2')) throw Error('Access denied'); };
  await assert.rejects(runCustomization(options), /Access denied/);
  assert(!events.some(event => event.startsWith('custom:')));
  events.length = 0; options.runCommand = execute;
  await runCustomization(options);
  assert(!events.includes('linux-playbook.yml:linux_vm_1'));
  assert(events.includes('custom:1:one') && events.includes('custom:2:one'));
});

test('custom failure is not automatically retried and resume skips successful blocks and Linux setup', async t => {
  const { options, events, job } = await setup(t, { linuxTargets: [{ vmid: 1, name: 'VM', ansibleTasks: [block('first'), block('second'), block('last')] }] });
  const execute = options.runTaskBlock;
  options.runTaskBlock = async args => {
    const result = await execute(args);
    if (!args.syntaxOnly && args.block.id === 'second') throw Error('Connection reset');
    return result;
  };
  await assert.rejects(runCustomization(options), /Connection reset/);
  assert.equal(events.filter(event => event === 'custom:1:second').length, 1);
  assert(!events.includes('custom:1:last'));
  assert.equal(job.data.customizationResults[1].taskResults.second.status, 'failed');
  events.length = 0; options.runTaskBlock = execute;
  await runCustomization(options);
  assert.deepEqual(events.filter(event => !event.startsWith('validate:')), ['custom:1:second', 'custom:1:last']);
});

test('disabled blocks do not run; readiness failure prevents fault injection', async t => {
  const { options, events, job } = await setup(t, { linuxTargets: [{ vmid: 1, name: 'VM', ansibleTasks: [{ ...block('disabled'), enabled: false }, block()] }] });
  job.data.readinessFailedVmids = [2];
  await assert.rejects(runCustomization(options), /guest readiness/);
  assert(!events.some(event => event.startsWith('custom:') || event.includes('disabled')));
});

test('syntax failure happens before any standard configuration', async t => {
  const { options, events } = await setup(t, { linuxTargets: [{ vmid: 1, name: 'VM', ansibleTasks: [block()] }] });
  options.runTaskBlock = async () => { throw Error('Unknown module'); };
  await assert.rejects(runCustomization(options), /Unknown module/);
  assert.deepEqual(events, []);
});

test('container receives only target credentials; no mounts or application environment, password output redacted', async () => {
  const calls = []; let copiedDirectory;
  const result = await runAnsibleTaskBlock({ block: block(), target: { ipAddress: '192.0.2.5', osType: 'ubuntu' }, password: 'guest-secret',
    runCommand: async (command, args, options) => {
      calls.push(args);
      assert.equal(command, 'docker'); assert.equal(options.quiet, true);
      assert.equal(options.env, undefined);
      if (args[0] === 'cp') {
        copiedDirectory = path.dirname(args[1]);
        const inventory = JSON.parse(await fs.readFile(path.join(copiedDirectory, 'inventory.json'), 'utf8'));
        assert.deepEqual(Object.keys(inventory.all.hosts), ['target']);
        assert.equal(inventory.all.hosts.target.ansible_host, '192.0.2.5');
      }
      return args[0] === 'inspect' ? '0' : 'guest-secret';
    }
  });
  assert.equal(result.output, '[redacted]');
  assert(calls[0].includes('--read-only') && calls[0].includes('--cap-drop=ALL'));
  assert(!calls[0].includes('-v') && !calls[0].includes('--mount'));
  assert.equal(calls.at(-1)[0], 'rm');
  await assert.rejects(fs.access(copiedDirectory));
});

test('syntax validation has no network or guest password and failed containers are removed', async () => {
  const calls = [];
  await assert.rejects(runAnsibleTaskBlock({ block: block(), syntaxOnly: true, password: 'secret', runCommand: async (_, args) => {
    calls.push(args);
    if (args[0] === 'create') { assert(args.includes('none')); assert(args.includes('--syntax-check')); }
    if (args[0] === 'cp') {
      const inventory = await fs.readFile(path.join(path.dirname(args[1]), 'inventory.json'), 'utf8');
      assert(!inventory.includes('secret'));
    }
    if (args[0] === 'start') throw Error('syntax error');
    return '';
  } }), /syntax error/);
  assert.equal(calls.at(-1)[0], 'rm');
});
