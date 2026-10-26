import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { kubernetesConfig } from '../../config/appConfig.js';
import { logger } from '../logging/logger.js';
export class KubernetesJobClient {
    constructor() {
        const kubeConfig = new KubeConfig();
        kubeConfig.loadFromDefault();
        this.batchApi = kubeConfig.makeApiClient(BatchV1Api);
        this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
        this.namespace = kubernetesConfig.namespace;
    }
    async createJob(options) {
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
        const jobManifest = {
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
        const result = await this.batchApi.createNamespacedJob({ namespace: this.namespace, body: jobManifest });
        const name = result?.body?.metadata?.name ?? result?.metadata?.name ?? options.jobName;
        logger.info({ job: name, executionId: options.executionId }, 'Created Kubernetes job');
        return result?.body ?? result;
    }
    async readJob(jobName) {
        const result = await this.batchApi.readNamespacedJob({ name: jobName, namespace: this.namespace });
        return result?.body ?? result;
    }
    async listJobPodNames(jobName) {
        const labelSelector = `job-name=${jobName}`;
        const result = await this.coreApi.listNamespacedPod({ namespace: this.namespace, labelSelector });
        const items = result?.items ?? result?.body?.items ?? [];
        return items
            .map((item) => item?.metadata?.name)
            .filter((name) => Boolean(name));
    }
    async readPodLogs(podName, containerName = 'run') {
        const result = await this.coreApi.readNamespacedPodLog({ name: podName, namespace: this.namespace, container: containerName, follow: false, previous: false });
        return typeof result === 'string' ? result : (result?.body ?? '');
    }
}
