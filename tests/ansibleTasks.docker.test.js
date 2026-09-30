import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAnsibleTaskBlock as executeTaskBlock } from '../lib/runAnsibleTasks.js';

async function runAnsibleTaskBlock(options) {
  try { return await executeTaskBlock(options); }
  catch (error) {
    error.message += `\n${error.stdout || ''}\n${error.stderr || ''}`;
    throw error;
  }
}

const enabled = process.env.ANSIBLE_TASKS_DOCKER_TEST === '1';
const makeBlock = yaml => ({ id: 'docker-test', name: 'Container integration test', yaml });

test('SSH initializes under the Kubernetes non-root UID on a read-only filesystem', { skip: !enabled }, async () => {
  const { stdout } = await promisify(execFile)('docker', [
    'run', '--rm', '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp', '--network', 'none',
    '--entrypoint', 'ssh', process.env.ANSIBLE_TASKS_IMAGE || 'labfactory/custom-tasks:1',
    '-G', 'target'
  ]);
  assert.match(stdout, /^user ansible$/m);
  assert.match(stdout, /^hostname target$/m);
});

test('real image resolves Windows DNS/ACL and Docker modules without contacting guests', { skip: !enabled }, async () => {
  const result = await runAnsibleTaskBlock({ syntaxOnly: true, block: makeBlock(`tasks:
  - ansible.windows.win_dns_record:
      zone: alpinatech.local
      name: files
      type: CNAME
      value: srv1.alpintech.local
  - ansible.windows.win_acl:
      path: 'C:\\Shares\\Projects'
      user: 'ALPINATECH\\DL-Projects-RW'
      rights: Modify
      type: allow
      state: absent
  - community.docker.docker_container:
      name: web2
      image: nginx:latest
      state: started
      ports: ['80:80']`) });
  assert.match(result.output, /playbook:/);
});

test('real image rejects an unknown module', { skip: !enabled }, async () => {
  await assert.rejects(runAnsibleTaskBlock({ syntaxOnly: true, block: makeBlock('- ansible.windows.nonexistent_module: {}') }));
});

test('real execution uses task variables and register within one block without exposing application environment', { skip: !enabled }, async () => {
  // Controller-only action plugins exercise real execution without any lab VM.
  const result = await runAnsibleTaskBlock({ target: { ipAddress: '192.0.2.1', osType: 'ubuntu' }, block: {
    ...makeBlock(`tasks:
  - ansible.builtin.debug:
      msg: '{{ exercise }}'
    register: first
  - ansible.builtin.assert:
      that:
        - first.msg == 'container-test'
        - lookup('ansible.builtin.env', 'DATABASE_URL') == ''
        - lookup('ansible.builtin.env', 'REDIS_PASSWORD') == ''`),
    variables: { exercise: 'container-test' }
  } });
  assert.match(result.output, /All assertions passed/);
});

test('real failed task is reported as a failure', { skip: !enabled }, async () => {
  await assert.rejects(runAnsibleTaskBlock({ target: { ipAddress: '192.0.2.1', osType: 'ubuntu' },
    block: makeBlock('- ansible.builtin.fail:\n    msg: intended-test-failure') }), error => /intended-test-failure/.test(error.stdout));
});
