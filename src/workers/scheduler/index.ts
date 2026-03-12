import { Worker } from 'bullmq';
import { redisConfig, queueConfig } from '../../config/appConfig.js';
import { ExecutionRepository } from '../../application/executions/executionRepository.js';
import { LockService } from '../../application/locking/lockService.js';
import { SchedulerService } from '../../application/scheduler/schedulerService.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { schedulerQueue, launcherQueue } from '../../infrastructure/queue/queues.js';

const lockService = new LockService();
const executionRepo = new ExecutionRepository();
const scheduler = new SchedulerService(executionRepo, lockService, schedulerQueue, launcherQueue);

const connection = {
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password
};

const start = async () => {
  await lockService.connect();

  const worker = new Worker(
    queueConfig.schedulerQueueName,
    async job => scheduler.handle(job),
    { connection, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Scheduler job failed');
  });

  const teardown = async () => {
    await worker.close();
    await lockService.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
};

start().catch(err => {
  logger.error({ err }, 'Scheduler failed to start');
  process.exit(1);
});
