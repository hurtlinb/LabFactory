import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ExecutionRepository } from '../application/executions/executionRepository.js';
import { logger } from '../infrastructure/logging/logger.js';

interface QueuePort {
  add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>): Promise<unknown>;
}

interface ApiDependencies {
  executionRepo: ExecutionRepository;
  schedulerQueue: QueuePort;
}

const executionSchema = z.object({
  type: z.enum(['terraform_plan', 'terraform_apply', 'ansible_run']),
  requestedBy: z.string().min(1),
  project: z.string().min(1),
  environment: z.string().min(1),
  target: z.string().min(1),
  lockKey: z.string().min(1).optional(),
  repository: z.string().min(1),
  gitRef: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional()
});

const cancelSchema = z.object({
  reason: z.string().optional()
});

const computeLockKey = (input: z.infer<typeof executionSchema>) => {
  if (input.lockKey) return input.lockKey;
  if (input.type === 'terraform_apply' || input.type === 'terraform_plan') {
    return `${input.project}:${input.environment}:terraform`;
  }
  const inventory =
    typeof input.payload?.inventory === 'string' && input.payload.inventory.length > 0
      ? input.payload.inventory
      : `${input.project}:${input.environment}`;
  return `${inventory}:${input.target}`;
};

const wrapAsync =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) =>
    fn(req, res).catch(err => {
      logger.error({ err }, 'Unhandled request error');
      res.status(500).json({ error: 'internal server error' });
    });

export const createApiApp = ({ executionRepo, schedulerQueue }: ApiDependencies) => {
  const app = express();
  app.use(express.json());
  const executionIdFrom = (req: Request): string =>
    Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  app.post(
    '/executions',
    wrapAsync(async (req, res) => {
      const parsed = executionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
        return;
      }

      const execution = await executionRepo.createExecution({
        ...parsed.data,
        lockKey: computeLockKey(parsed.data)
      });
      await executionRepo.appendLog({
        executionId: execution.id,
        stream: 'system',
        message: 'Execution created and queued'
      });
      await schedulerQueue.add(
        'schedule',
        { executionId: execution.id },
        { removeOnComplete: true, attempts: 5, backoff: { type: 'exponential', delay: 3000 } }
      );

      res.status(202).json({ executionId: execution.id });
    })
  );

  app.get(
    '/executions/:id',
    wrapAsync(async (req, res) => {
      const executionId = executionIdFrom(req);
      const execution = await executionRepo.findById(executionId);
      if (!execution) {
        res.status(404).json({ error: 'execution not found' });
        return;
      }
      res.json(execution);
    })
  );

  app.get(
    '/executions/:id/logs',
    wrapAsync(async (req, res) => {
      const executionId = executionIdFrom(req);
      const execution = await executionRepo.findById(executionId);
      if (!execution) {
        res.status(404).json({ error: 'execution not found' });
        return;
      }
      const logs = await executionRepo.listLogs(executionId);
      res.json(logs);
    })
  );

  app.post(
    '/executions/:id/cancel',
    wrapAsync(async (req, res) => {
      const executionId = executionIdFrom(req);
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid cancel payload' });
        return;
      }
      const existing = await executionRepo.findById(executionId);
      if (!existing) {
        res.status(404).json({ error: 'execution not found' });
        return;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(existing.status)) {
        res.status(409).json({ error: `cannot cancel execution in status ${existing.status}` });
        return;
      }
      const reason = parsed.data.reason ?? 'Cancelled by API';
      await executionRepo.updateStatus(executionId, 'cancelled', {
        finishedAt: new Date(),
        errorSummary: reason
      });
      await executionRepo.appendLog({
        executionId: existing.id,
        stream: 'system',
        message: `Execution cancelled: ${reason}`
      });
      res.json({ ok: true, executionId: existing.id });
    })
  );

  app.get('/healthz', (req, res) => res.send('ok'));
  return app;
};
