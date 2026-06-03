import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApiApp } from '../src/api/app';
import { SchedulerService } from '../src/application/scheduler/schedulerService';
import { LauncherService } from '../src/application/launch/launcherService';
import { LockService } from '../src/application/locking/lockService';
import { Execution, ExecutionStatus, ExecutionType } from '../src/domain/models/execution';
import { ExecutionLog, ExecutionStream } from '../src/domain/models/executionLog';

class InMemoryRedis {
  private store = new Map<string, string>();
  isOpen = true;

  async set(key: string, value: string, opts: { NX?: boolean }) {
    if (opts.NX && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return 'OK';
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    const stored = this.store.get(options.keys[0]);
    if (stored && stored.startsWith(options.arguments[0])) {
      this.store.delete(options.keys[0]);
      return 1;
    }
    return 0;
  }

  async connect() {
    this.isOpen = true;
  }

  async disconnect() {
    this.isOpen = false;
  }
}

class InMemoryQueue {
  jobs: Array<{ name: string; data: Record<string, unknown>; opts?: Record<string, unknown> }> = [];

  async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
    this.jobs.push({ name, data, opts });
    return { id: String(this.jobs.length) };
  }
}

class InMemoryExecutionRepository {
  private executions = new Map<string, Execution>();
  private logs = new Map<string, ExecutionLog[]>();
  private sequence = 1;

  async createExecution(input: {
    type: ExecutionType;
    requestedBy: string;
    project: string;
    environment: string;
    target: string;
    lockKey: string;
    repository: string;
    gitRef: string;
    payload?: Record<string, unknown>;
  }): Promise<Execution> {
    const now = new Date().toISOString();
    const id = `exec-${this.sequence++}`;
    const execution: Execution = {
      id,
      type: input.type,
      status: 'queued',
      requestedBy: input.requestedBy,
      project: input.project,
      environment: input.environment,
      target: input.target,
      lockKey: input.lockKey,
      repository: input.repository,
      gitRef: input.gitRef,
      payload: input.payload ?? {},
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      errorSummary: null,
      createdAt: now,
      updatedAt: now
    };
    this.executions.set(id, execution);
    return execution;
  }

  async findById(id: string): Promise<Execution | null> {
    return this.executions.get(id) ?? null;
  }

  async updateStatus(
    id: string,
    status: ExecutionStatus,
    opts: Partial<{ startedAt: Date | null; finishedAt: Date | null; exitCode: number | null; errorSummary: string | null }> = {}
  ): Promise<Execution | null> {
    const current = this.executions.get(id);
    if (!current) return null;
    const updated: Execution = {
      ...current,
      status,
      startedAt:
        Object.prototype.hasOwnProperty.call(opts, 'startedAt') && opts.startedAt
          ? opts.startedAt.toISOString()
          : Object.prototype.hasOwnProperty.call(opts, 'startedAt')
            ? null
            : current.startedAt,
      finishedAt:
        Object.prototype.hasOwnProperty.call(opts, 'finishedAt') && opts.finishedAt
          ? opts.finishedAt.toISOString()
          : Object.prototype.hasOwnProperty.call(opts, 'finishedAt')
            ? null
            : current.finishedAt,
      exitCode:
        Object.prototype.hasOwnProperty.call(opts, 'exitCode') && opts.exitCode !== undefined
          ? opts.exitCode
          : current.exitCode,
      errorSummary:
        Object.prototype.hasOwnProperty.call(opts, 'errorSummary') && opts.errorSummary !== undefined
          ? opts.errorSummary
          : current.errorSummary,
      updatedAt: new Date().toISOString()
    };
    this.executions.set(id, updated);
    return updated;
  }

  async appendLog(log: { executionId: string; stream: ExecutionStream; message: string }) {
    const list = this.logs.get(log.executionId) ?? [];
    list.push({
      id: `log-${list.length + 1}`,
      executionId: log.executionId,
      timestamp: new Date().toISOString(),
      stream: log.stream,
      message: log.message
    });
    this.logs.set(log.executionId, list);
  }

  async listLogs(executionId: string): Promise<ExecutionLog[]> {
    return this.logs.get(executionId) ?? [];
  }

  async hasSchedulingConflict(execution: Pick<Execution, 'id' | 'type' | 'project' | 'environment' | 'target'>) {
    const active = new Set<ExecutionStatus>(['scheduled', 'preparing', 'running']);
    for (const candidate of this.executions.values()) {
      if (candidate.id === execution.id || !active.has(candidate.status)) continue;

      if (execution.type === 'terraform_apply') {
        if (
          candidate.type === 'terraform_apply' &&
          candidate.project === execution.project &&
          candidate.environment === execution.environment
        ) {
          return true;
        }
      } else if (execution.type === 'terraform_plan') {
        if (
          candidate.type === 'terraform_apply' &&
          candidate.project === execution.project &&
          candidate.environment === execution.environment
        ) {
          return true;
        }
      } else if (
        candidate.type === 'ansible_run' &&
        candidate.project === execution.project &&
        candidate.environment === execution.environment &&
        candidate.target === execution.target
      ) {
        return true;
      }
    }
    return false;
  }
}

class FakeKubernetesClient {
  private jobName = '';

  async createJob(options: { jobName: string }) {
    this.jobName = options.jobName;
    return { metadata: { name: options.jobName } };
  }

  async readJob(_jobName: string) {
    return { status: { succeeded: 1 } };
  }

  async listJobPodNames(_jobName: string) {
    return ['pod-1'];
  }

  async readPodLogs(_podName: string, _containerName: string) {
    return 'terraform init complete\n[stderr] warning line';
  }
}

describe('API -> scheduler -> launcher lifecycle', () => {
  it('creates, schedules, launches, ingests logs, and completes execution', async () => {
    const executionRepo = new InMemoryExecutionRepository();
    const schedulerQueue = new InMemoryQueue();
    const launcherQueue = new InMemoryQueue();
    const lockService = new LockService(new InMemoryRedis() as any);
    await lockService.connect();

    const app = createApiApp({ executionRepo: executionRepo as any, schedulerQueue: schedulerQueue as any });
    const response = await request(app).post('/executions').send({
      type: 'terraform_apply',
      requestedBy: 'alice',
      project: 'proj-a',
      environment: 'dev',
      target: 'workspace-a',
      repository: 'git@example/repo',
      gitRef: 'main',
      payload: { hello: 'world' }
    });

    expect(response.status).toBe(202);
    const executionId = response.body.executionId as string;
    expect(executionId).toBeTruthy();
    expect(schedulerQueue.jobs.length).toBe(1);

    const scheduler = new SchedulerService(
      executionRepo as any,
      lockService,
      schedulerQueue as any,
      launcherQueue as any
    );
    await scheduler.handle({ data: { executionId } } as any);
    expect(launcherQueue.jobs.length).toBe(1);

    const launcher = new LauncherService(
      executionRepo as any,
      lockService,
      new FakeKubernetesClient() as any
    );
    const execution = await executionRepo.findById(executionId);
    expect(execution?.status).toBe('scheduled');

    await launcher.handle(execution as Execution);

    const finalExecution = await executionRepo.findById(executionId);
    expect(finalExecution?.status).toBe('succeeded');
    expect(finalExecution?.exitCode).toBe(0);

    const logs = await executionRepo.listLogs(executionId);
    expect(logs.some(log => log.stream === 'stdout' && log.message.includes('terraform init complete'))).toBe(true);
    expect(logs.some(log => log.stream === 'stderr' && log.message.includes('warning line'))).toBe(true);
  });

  it('enforces terraform_apply serialization per environment', async () => {
    const executionRepo = new InMemoryExecutionRepository();
    const schedulerQueue = new InMemoryQueue();
    const launcherQueue = new InMemoryQueue();
    const lockService = new LockService(new InMemoryRedis() as any);
    await lockService.connect();

    const running = await executionRepo.createExecution({
      type: 'terraform_apply',
      requestedBy: 'alice',
      project: 'proj-a',
      environment: 'dev',
      target: 'workspace-a',
      lockKey: 'proj-a:dev:terraform',
      repository: 'git@example/repo',
      gitRef: 'main'
    });
    await executionRepo.updateStatus(running.id, 'running');

    const queued = await executionRepo.createExecution({
      type: 'terraform_apply',
      requestedBy: 'bob',
      project: 'proj-a',
      environment: 'dev',
      target: 'workspace-b',
      lockKey: 'proj-a:dev:terraform',
      repository: 'git@example/repo',
      gitRef: 'main'
    });

    const scheduler = new SchedulerService(
      executionRepo as any,
      lockService,
      schedulerQueue as any,
      launcherQueue as any
    );
    await scheduler.handle({ data: { executionId: queued.id } } as any);

    expect(launcherQueue.jobs.length).toBe(0);
    expect(schedulerQueue.jobs.length).toBe(1);
    const logs = await executionRepo.listLogs(queued.id);
    expect(logs.some(log => log.message.includes('Scheduling conflict'))).toBe(true);
  });
});
