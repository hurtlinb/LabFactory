import { ExecutionRepository } from '../executions/executionRepository.js';
import { Execution } from '../../domain/models/execution.js';
import { KubernetesJobClient } from '../../infrastructure/k8s/kubernetesJobClient.js';
import { kubernetesConfig, launcherConfig } from '../../config/appConfig.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { LockService } from '../locking/lockService.js';

interface RunnerDefinition {
  image: string;
  command: string[];
}

const MAX_LOG_LINES = 1000;

export class LauncherService {
  constructor(
    private executionRepo: ExecutionRepository,
    private lockService: LockService,
    private jobClient: KubernetesJobClient = new KubernetesJobClient()
  ) {}

  private getRunner(execution: Execution): RunnerDefinition {
    if (execution.type === 'terraform_plan' || execution.type === 'terraform_apply') {
      return {
        image: kubernetesConfig.terraformRunnerImage,
        command: ['/entrypoint.sh']
      };
    }

    return {
      image: kubernetesConfig.ansibleRunnerImage,
      command: ['/entrypoint.sh']
    };
  }

  async handle(execution: Execution) {
    if (execution.status !== 'scheduled') {
      logger.info({ executionId: execution.id, status: execution.status }, 'Skipping launch: invalid state');
      return;
    }

    await this.executionRepo.updateStatus(execution.id, 'preparing');
    await this.executionRepo.appendLog({
      executionId: execution.id,
      stream: 'system',
      message: 'Preparing Kubernetes job launch'
    });
    const runner = this.getRunner(execution);
    const jobName = `execution-${execution.id.substring(0, 8)}-${Date.now()}`;
    const labels = {
      'execution-id': execution.id,
      'execution-type': execution.type,
      project: execution.project,
      environment: execution.environment
    };

    const env = {
      EXECUTION_ID: execution.id,
      EXECUTION_TYPE: execution.type,
      PROJECT: execution.project,
      ENVIRONMENT: execution.environment,
      TARGET: execution.target,
      REPOSITORY: execution.repository,
      GIT_REF: execution.gitRef
    };

    try {
      await this.jobClient.createJob({
        executionId: execution.id,
        jobName,
        image: runner.image,
        command: runner.command,
        env,
        labels,
        secretRefs: [] // TODO map secret references from payload once secret store is wired
      });

      await this.executionRepo.updateStatus(execution.id, 'running', { startedAt: new Date() });
      await this.executionRepo.appendLog({
        executionId: execution.id,
        stream: 'system',
        message: `Kubernetes job ${jobName} is running`
      });
      logger.info({ executionId: execution.id, jobName }, 'Kubernetes job created');

      const result = await this.waitForJobCompletion(jobName, execution.id);
      await this.ingestRunnerLogs(execution.id, jobName);
      const finishedAt = new Date();
      const finalStatus = result.succeeded ? 'succeeded' : 'failed';
      await this.executionRepo.updateStatus(execution.id, finalStatus, {
        finishedAt,
        exitCode: result.succeeded ? 0 : 1,
        errorSummary: result.errorSummary ?? null
      });
      await this.executionRepo.appendLog({
        executionId: execution.id,
        stream: 'system',
        message: result.succeeded
          ? `Execution completed successfully (job ${jobName})`
          : `Execution failed (job ${jobName}): ${result.errorSummary ?? 'unknown error'}`
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.executionRepo.updateStatus(execution.id, 'failed', {
        finishedAt: new Date(),
        exitCode: 1,
        errorSummary: errorMessage
      });
      await this.executionRepo.appendLog({
        executionId: execution.id,
        stream: 'system',
        message: `Execution failed before completion: ${errorMessage}`
      });
      await this.ingestRunnerLogs(execution.id, jobName);
      throw err;
    } finally {
      await this.lockService.release(execution.lockKey, execution.id);
    }
  }

  private async waitForJobCompletion(jobName: string, executionId: string): Promise<{ succeeded: boolean; errorSummary?: string }> {
    const startedAt = Date.now();
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > launcherConfig.jobTimeoutMs) {
        return { succeeded: false, errorSummary: 'job timed out while waiting for completion' };
      }

      const job = await this.jobClient.readJob(jobName);
      const status = job?.status ?? {};
      if (status.succeeded && status.succeeded > 0) {
        return { succeeded: true };
      }

      if (status.failed && status.failed > 0) {
        const failedCondition = status.conditions?.find((c: any) => c.type === 'Failed');
        return {
          succeeded: false,
          errorSummary: failedCondition?.message ?? status.conditions?.[0]?.message ?? 'job failed'
        };
      }

      await this.executionRepo.appendLog({
        executionId,
        stream: 'system',
        message: `Waiting for job ${jobName} completion`
      });
      await new Promise(resolve => setTimeout(resolve, launcherConfig.pollIntervalMs));
    }
  }

  private async ingestRunnerLogs(executionId: string, jobName: string) {
    try {
      const podNames = await this.jobClient.listJobPodNames(jobName);
      for (const podName of podNames) {
        const rawLogs = await this.jobClient.readPodLogs(podName, 'run');
        if (!rawLogs || !rawLogs.trim()) {
          continue;
        }

        const lines = rawLogs
          .split(/\r?\n/)
          .map(line => line.trimEnd())
          .filter(line => line.length > 0)
          .slice(0, MAX_LOG_LINES);

        for (const line of lines) {
          const stream = line.startsWith('[stderr]') ? 'stderr' : 'stdout';
          const message = line.startsWith('[stderr]') ? line.replace(/^\[stderr\]\s*/, '') : line;
          await this.executionRepo.appendLog({
            executionId,
            stream,
            message
          });
        }
      }
    } catch (err) {
      logger.warn({ executionId, jobName, err }, 'Unable to ingest runner logs from Kubernetes');
      await this.executionRepo.appendLog({
        executionId,
        stream: 'system',
        message: `Unable to ingest runner logs for ${jobName}`
      });
    }
  }
}
