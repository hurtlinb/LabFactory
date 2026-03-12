import { Worker } from 'bullmq';
import { redisConfig, queueConfig } from '../../config/appConfig.js';
import { ExecutionRepository } from '../../application/executions/executionRepository.js';
import { LauncherService } from '../../application/launch/launcherService.js';
import { LockService } from '../../application/locking/lockService.js';
import { logger } from '../../infrastructure/logging/logger.js';

const executionRepo = new ExecutionRepository();
const lockService = new LockService();
const launcherService = new LauncherService(executionRepo, lockService);

const connection = {
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password
};

const start = async () => {
  await lockService.connect();
  const worker = new Worker(
    queueConfig.launcherQueueName,
    async job => {
      const { executionId } = job.data;
      if (!executionId) {
        logger.warn('Launcher job missing executionId');
        return;
      }
      const execution = await executionRepo.findById(executionId);
      if (!execution) {
        logger.warn({ executionId }, 'Execution missing for launcher');
        return;
      }
      await launcherService.handle(execution);
    },
    { connection, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Launcher job failed');
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
  logger.error({ err }, 'Launcher failed to start');
  process.exit(1);
});
