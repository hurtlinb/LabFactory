import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const body = response => response?.body ?? response;
const statusCode = error => error.statusCode ?? error.response?.statusCode ?? error.body?.code;

export function taskJobManifest({ name, namespace, image, syntaxOnly, imagePullSecrets = [] }) {
  return {
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'labfactory-custom-tasks' } },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: syntaxOnly ? 120 : 1800, ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: { 'labfactory.io/custom-tasks': 'true', 'labfactory.io/task-mode': syntaxOnly ? 'validation' : 'execution' } },
        spec: {
          restartPolicy: 'Never', terminationGracePeriodSeconds: 10, automountServiceAccountToken: false, enableServiceLinks: false,
          serviceAccountName: 'labfactory-task-runner', imagePullSecrets: imagePullSecrets.map(name => ({ name })),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'ansible', image, imagePullPolicy: 'IfNotPresent',
            args: ['-i', '/workspace/inventory.json', '/workspace/tasks.json', ...(syntaxOnly ? ['--syntax-check'] : [])],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            volumeMounts: [{ name: 'input', mountPath: '/workspace', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }]
          }],
          volumes: [{ name: 'input', secret: { secretName: name, defaultMode: 0o440 } }, { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '128Mi' } }]
        }
      }
    }
  };
}

async function clients() {
  const { KubeConfig, BatchV1Api, CoreV1Api } = await import('@kubernetes/client-node');
  const config = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else config.loadFromDefault();
  const batch = config.makeApiClient(BatchV1Api);
  const core = config.makeApiClient(CoreV1Api);
  for (const client of [batch, core]) client.addInterceptor(options => { options.timeout = 15000; });
  const namespace = process.env.K8S_NAMESPACE || (await readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8')).trim();
  return { batch, core, namespace };
}

export async function runKubernetesTaskBlock({ playbook, inventory, syntaxOnly = false, signal, api, sleep = delay, image = process.env.ANSIBLE_TASKS_IMAGE }) {
  if (!image) throw new Error('ANSIBLE_TASKS_IMAGE must reference the published custom-tasks image for Kubernetes');
  const { batch, core, namespace } = api || await clients();
  const name = `lf-tasks-${randomUUID()}`;
  const deadline = AbortSignal.timeout(syntaxOnly ? 150000 : 1830000);
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const manifest = taskJobManifest({ name, namespace, image, syntaxOnly,
    imagePullSecrets: (process.env.ANSIBLE_TASKS_IMAGE_PULL_SECRETS || '').split(',').map(value => value.trim()).filter(Boolean) });
  let created = false;
  let output = '';
  try {
    operationSignal.throwIfAborted();
    // Create the Job first: it waits for its input Secret, which is garbage-collected
    // with the Job even if the worker dies. The Job deadline covers startup too.
    const job = body(await batch.createNamespacedJob(namespace, manifest));
    created = true;
    operationSignal.throwIfAborted();
    await core.createNamespacedSecret(namespace, {
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true,
      metadata: { name, namespace, ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: job.metadata.uid }] },
      stringData: { 'tasks.json': playbook, 'inventory.json': inventory }
    });
    for (;;) {
      operationSignal.throwIfAborted();
      const current = body(await batch.readNamespacedJob(name, namespace));
      const pods = body(await core.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `job-name=${name}`)).items || [];
      const pod = pods[0];
      const state = pod?.status?.containerStatuses?.[0]?.state;
      if (state?.waiting && ['ImagePullBackOff', 'InvalidImageName'].includes(state.waiting.reason)) {
        throw new Error(`${state.waiting.reason}: ${state.waiting.message || image}`);
      }
      const failed = current.status?.conditions?.find(condition => ['Failed', 'FailureTarget'].includes(condition.type) && condition.status === 'True');
      if (state?.terminated || current.status?.succeeded || failed) {
        if (pod) {
          try { output = body(await core.readNamespacedPodLog(pod.metadata.name, namespace, 'ansible', false, false, 262144)) || ''; }
          catch { output = ''; }
        }
        if (failed || (state?.terminated && state.terminated.exitCode !== 0)) {
          throw Object.assign(new Error(failed?.message || state?.terminated?.reason || 'Ansible Kubernetes Job failed'), { stdout: output });
        }
        return { output, image };
      }
      await sleep(1000, undefined, { signal: operationSignal });
    }
  } catch (error) {
    // SDK errors contain request bodies (including Secrets). Never propagate those.
    const message = error.body?.message || error.message || 'Kubernetes task execution failed';
    throw Object.assign(new Error(message), { stdout: error.stdout || output });
  } finally {
    // Also attempt cleanup after an ambiguous create timeout; the random name is ours.
    try { await batch.deleteNamespacedJob(name, namespace, undefined, undefined, 0, undefined, 'Background'); }
    catch (error) { if (statusCode(error) !== 404) console.warn(`Unable to remove task Job ${namespace}/${name}; its deadline and TTL will clean it up`); }
    if (created) {
      try { await core.deleteNamespacedSecret(name, namespace); }
      catch (error) { if (statusCode(error) !== 404) console.warn(`Unable to remove task input ${namespace}/${name}; its Job owner will clean it up`); }
    }
  }
}
