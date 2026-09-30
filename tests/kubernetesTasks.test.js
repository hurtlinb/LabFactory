import test from 'node:test';
import assert from 'node:assert/strict';
import { runKubernetesTaskBlock as execute, taskJobManifest } from '../lib/runKubernetesTasks.js';
import { buildTaskInventory } from '../lib/runAnsibleTasks.js';

const runKubernetesTaskBlock = options => execute({ ...options, image: 'registry/tasks:v1' });

function fakeApi(states = [{ containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] }]) {
  const events = [];
  let lastJob;
  return { events, namespace: 'test', batch: {
    async createNamespacedJob(namespace, job) { events.push(['job', job]); lastJob = job; return { body: { metadata: { ...job.metadata, uid: 'job-uid' } } }; },
    async readNamespacedJob() { return { body: { status: {} } }; },
    async deleteNamespacedJob(...args) { events.push(['deleteJob', ...args]); }
  }, core: {
    async createNamespacedSecret(namespace, secret) { events.push(['secret', secret]); },
    async listNamespacedPod() { return { body: { items: [{ metadata: { name: lastJob.metadata.name + '-pod' }, status: states.length > 1 ? states.shift() : states[0] }] } }; },
    async readNamespacedPodLog() { return { body: 'Ansible output' }; },
    async deleteNamespacedSecret(...args) { events.push(['deleteSecret', ...args]); }
  } };
}

test('job isolates credentials, disables API tokens and retries, and has resource and time limits', () => {
  const manifest = taskJobManifest({ name: 'test', namespace: 'dev', image: 'registry/tasks:v1', syntaxOnly: true, imagePullSecrets: ['pull'] });
  assert.equal(manifest.spec.backoffLimit, 0);
  assert.equal(manifest.spec.activeDeadlineSeconds, 120);
  assert.equal(manifest.spec.ttlSecondsAfterFinished, 300);
  const spec = manifest.spec.template.spec;
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.serviceAccountName, 'labfactory-task-runner');
  assert.equal(spec.securityContext.runAsNonRoot, true);
  assert.equal(spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(spec.containers[0].env, undefined);
  assert(spec.containers[0].args.includes('--syntax-check'));
  assert.equal(spec.volumes[0].secret.defaultMode, 0o440);
  assert.deepEqual(spec.imagePullSecrets, [{ name: 'pull' }]);
  assert(!JSON.stringify(manifest).includes('hostPath'));
});

test('syntax inventory never contains the guest password', () => {
  const inventory = buildTaskInventory({ target: { ipAddress: '192.0.2.1', windowsAdminPassword: 'secret' }, syntaxOnly: true });
  assert.deepEqual(inventory, { all: { hosts: { target: { ansible_connection: 'local' } } } });
});

test('creates an owned Secret, polls, collects output and cleans both resources', async t => {
  const api = fakeApi([{ phase: 'Pending' }, { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] }]);
  const result = await runKubernetesTaskBlock({ playbook: 'tasks', inventory: 'private', api, sleep: async () => {} });
  assert.equal(result.output, 'Ansible output');
  const secret = api.events.find(event => event[0] === 'secret')[1];
  assert.equal(secret.stringData['inventory.json'], 'private');
  assert.equal(secret.metadata.ownerReferences[0].uid, 'job-uid');
  assert.deepEqual(api.events.map(event => event[0]), ['job', 'secret', 'deleteJob', 'deleteSecret']);
});

test('failed tasks preserve bounded logs and clean resources without retrying execution', async t => {
  const api = fakeApi([{ containerStatuses: [{ state: { terminated: { exitCode: 2, reason: 'Error' } } }] }]);
  await assert.rejects(runKubernetesTaskBlock({ playbook: '', inventory: '', api }), error => error.stdout === 'Ansible output');
  assert.equal(api.events.filter(event => event[0] === 'job').length, 1);
  assert.equal(api.events.at(-1)[0], 'deleteSecret');
});

test('cancellation removes a pending Job and its input', async t => {
  const controller = new AbortController();
  const api = fakeApi([{ phase: 'Pending' }]);
  await assert.rejects(runKubernetesTaskBlock({ playbook: '', inventory: '', api, signal: controller.signal,
    sleep: async () => controller.abort(new Error('Cancelled')) }), /Cancelled/);
  assert.equal(api.events.at(-1)[0], 'deleteSecret');
});

test('API failures never expose request bodies and cleanup follows a Secret creation failure', async t => {
  const api = fakeApi();
  api.core.createNamespacedSecret = async () => { throw Object.assign(new Error('SDK internals'), { body: { message: 'Forbidden' }, request: { secret: 'password' } }); };
  await assert.rejects(runKubernetesTaskBlock({ playbook: '', inventory: '', api }), error => {
    assert.equal(error.message, 'Forbidden');
    assert.equal(error.request, undefined);
    return true;
  });
  assert.equal(api.events.at(-1)[0], 'deleteSecret');
});

test('image pull failures produce actionable errors rather than hanging', async t => {
  const api = fakeApi([{ containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'image not found' } } }] }]);
  await assert.rejects(runKubernetesTaskBlock({ playbook: '', inventory: '', api }), /ImagePullBackOff: image not found/);
});
