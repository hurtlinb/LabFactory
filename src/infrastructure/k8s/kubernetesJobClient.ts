import { BatchV1Api, CoreV1Api, KubeConfig, V1Job } from '@kubernetes/client-node';
import { kubernetesConfig } from '../../config/appConfig.js';
import { logger } from '../logging/logger.js';

export interface KubernetesJobOptions {
  executionId: string;
  jobName: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  secretRefs?: Array<{ name: string; key: string; envName: string }>;
}

export class KubernetesJobClient {
  private batchApi: BatchV1Api;
  private coreApi: CoreV1Api;
  private namespace: string;

  constructor() {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    this.batchApi = kubeConfig.makeApiClient(BatchV1Api);
    this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
    this.namespace = kubernetesConfig.namespace;
  }

  async createJob(options: KubernetesJobOptions) {
    const envVars = Object.entries(options.env).map(([name, value]) => ({
      name,
      value
    }));

    const secretEnv = (options.secretRefs ?? []).map(ref => ({
      name: ref.envName,
      valueFrom: {
        secretKeyRef: {
          name: ref.name,
          key: ref.key
        }
      }
    }));

    const jobManifest: V1Job = {
      metadata: {
        name: options.jobName,
        labels: options.labels
      },
      spec: {
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        template: {
          metadata: {
            labels: options.labels
          },
          spec: {
            serviceAccountName: kubernetesConfig.serviceAccount,
            restartPolicy: 'Never',
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: 'RuntimeDefault' }
            },
            containers: [
              {
                name: 'run',
                image: options.image,
                command: options.command,
                env: [...envVars, ...secretEnv],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: false,
                  capabilities: { drop: ['ALL'] }
                }
              }
            ]
          }
        }
      }
    };

    const result = await (this.batchApi as any).createNamespacedJob(this.namespace, jobManifest);
    const name = result?.body?.metadata?.name ?? result?.metadata?.name ?? options.jobName;
    logger.info({ job: name, executionId: options.executionId }, 'Created Kubernetes job');
    return result?.body ?? result;
  }

  async readJob(jobName: string) {
    const result = await (this.batchApi as any).readNamespacedJob(jobName, this.namespace);
    return result?.body ?? result;
  }

  async listJobPodNames(jobName: string): Promise<string[]> {
    const labelSelector = `job-name=${jobName}`;
    const result = await (this.coreApi as any).listNamespacedPod(this.namespace, undefined, undefined, undefined, undefined, labelSelector);
    const items = result?.items ?? result?.body?.items ?? [];
    return items
      .map((item: any) => item?.metadata?.name)
      .filter((name: string | undefined): name is string => Boolean(name));
  }

  async readPodLogs(podName: string, containerName = 'run'): Promise<string> {
    const result = await (this.coreApi as any).readNamespacedPodLog(
      podName,
      this.namespace,
      containerName,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    return typeof result === 'string' ? result : (result?.body ?? '');
  }
}
