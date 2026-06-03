import { schedulerQueue } from '../infrastructure/queue/queues.js';
import { ExecutionRepository } from '../application/executions/executionRepository.js';
import { appConfig } from '../config/appConfig.js';
import { runMigrations } from '../infrastructure/db/runMigrations.js';
import { logger } from '../infrastructure/logging/logger.js';
import { createApiApp } from './app.js';

const executionRepo = new ExecutionRepository();
const app = createApiApp({ executionRepo, schedulerQueue });

const start = async () => {
  await runMigrations();
  app.listen(appConfig.port, () => {
    logger.info({ port: appConfig.port }, 'API listening');
  });
};

start().catch(err => {
  logger.error({ err }, 'Failed to start API');
  process.exit(1);
});
