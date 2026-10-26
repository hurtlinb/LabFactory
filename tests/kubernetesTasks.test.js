import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { KubeConfig, BatchV1Api, CoreV1Api } from '@kubernetes/client-node';
import { runKubernetesTaskBlock as execute, taskJobManifest } from '../lib/runKubernetesTasks.js';
import { buildTaskInventory } from '../lib/runAnsibleTasks.js';

const runKubernetesTaskBlock = options => execute({ ...options, image: 'registry/tasks:v1' });

function fakeApi(states = [{ containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] }]) {
  const events = [];
  let lastJob;
  return { events, namespace: 'test', batch: {
    async createNamespacedJob({ namespace, body: job }) { assert.equal(namespace, 'test'); events.push(['job', job]); lastJob = job; return { metadata: { ...job.metadata, uid: 'job-uid' } }; },
    async readNamespacedJob() { return { status: {} }; },
    async deleteNamespacedJob(...args) { events.push(['deleteJob', ...args]); }
  }, core: {
    async createNamespacedSecret({ namespace, body: secret }) { assert.equal(namespace, 'test'); events.push(['secret', secret]); },
    async listNamespacedPod() { return { items: [{ metadata: { name: lastJob.metadata.name + '-pod' }, status: states.length > 1 ? states.shift() : states[0] }] }; },
    async readNamespacedPodLog() { return 'Ansible output'; },
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

test('real SDK serializes requests, reads logs, sanitizes errors and cleans up after cancellation', async t => {
  for (const scenario of ['success', 'forbidden', 'cancel', 'timeout']) {
    await t.test(scenario, async t => {
      const requests = [];
      const controller = new AbortController();
      let jobName;
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = Buffer.concat(chunks).toString();
        const url = new URL(req.url, 'http://localhost');
        requests.push({ method: req.method, url, payload: payload && JSON.parse(payload) });
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'DELETE') {
          res.statusCode = 404;
          res.end(JSON.stringify({ kind: 'Status', code: 404, message: 'Already gone' }));
        } else if (req.method === 'POST' && url.pathname.endsWith('/jobs')) {
          jobName = JSON.parse(payload).metadata.name;
          res.statusCode = 201;
          res.end(JSON.stringify({ metadata: { name: jobName, uid: 'real-uid' } }));
        } else if (req.method === 'POST') {
          res.statusCode = scenario === 'forbidden' ? 403 : 201;
          res.end(JSON.stringify(scenario === 'forbidden'
            ? { kind: 'Status', code: 403, message: 'private-password' }
            : { metadata: { name: jobName } }));
        } else if (scenario === 'cancel') {
          controller.abort(new Error('Cancelled in flight'));
        } else if (scenario === 'timeout') {
          // Leave the request pending to exercise the SDK transport deadline.
        } else if (url.pathname.endsWith('/log')) {
          res.setHeader('Content-Type', 'text/plain');
          res.end('Real SDK output');
        } else if (url.pathname.endsWith('/pods')) {
          res.end(JSON.stringify({ items: [{ metadata: { name: `${jobName}-pod` }, status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] } }] }));
        } else {
          res.end(JSON.stringify({ status: { succeeded: 1 } }));
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      });
      const config = new KubeConfig();
      config.loadFromOptions({
        clusters: [{ name: 'local', server: `http://127.0.0.1:${server.address().port}`, skipTLSVerify: true }],
        users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'local', user: 'test' }], currentContext: 'test'
      });
      const api = { namespace: 'test', batch: config.makeApiClient(BatchV1Api), core: config.makeApiClient(CoreV1Api) };
      const result = runKubernetesTaskBlock({ api, playbook: 'tasks', inventory: 'private-password', signal: controller.signal });
      if (scenario === 'success') {
        assert.equal((await result).output, 'Real SDK output');
        const pods = requests.find(r => r.url.pathname.endsWith('/pods'));
        assert.equal(pods.url.searchParams.get('labelSelector'), `job-name=${jobName}`);
        const logs = requests.find(r => r.url.pathname.endsWith('/log'));
        assert.equal(logs.url.searchParams.get('limitBytes'), '262144');
        assert.equal(logs.url.searchParams.get('container'), 'ansible');
      } else if (scenario === 'forbidden') {
        await assert.rejects(result, error => {
          assert.equal(error.message, 'Kubernetes API request failed (HTTP 403)');
          assert(!JSON.stringify(error).includes('private-password'));
          return true;
        });
      } else if (scenario === 'cancel') {
        await assert.rejects(result, /Cancelled in flight/);
      } else {
        await assert.rejects(result, /timeout/i);
      }
      const secret = requests.find(r => r.method === 'POST' && r.url.pathname.endsWith('/secrets'));
      assert.equal(secret.payload.metadata.ownerReferences[0].uid, 'real-uid');
      const cleanup = requests.filter(r => r.method === 'DELETE');
      assert.equal(cleanup.length, 2);
      assert.equal(cleanup[0].url.pathname, `/apis/batch/v1/namespaces/test/jobs/${jobName}`);
      assert.equal(cleanup[0].url.searchParams.get('propagationPolicy'), 'Background');
      assert.equal(cleanup[0].url.searchParams.get('gracePeriodSeconds'), '0');
      assert.equal(cleanup[1].url.pathname, `/api/v1/namespaces/test/secrets/${jobName}`);
    });
  }
});
