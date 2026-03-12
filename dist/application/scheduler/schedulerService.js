import { lockConfig } from '../../config/appConfig.js';
import { logger } from '../../infrastructure/logging/logger.js';
export class SchedulerService {
    constructor(executionRepo, lockService, schedulerQueue, launcherQueue) {
        this.executionRepo = executionRepo;
        this.lockService = lockService;
        this.schedulerQueue = schedulerQueue;
        this.launcherQueue = launcherQueue;
    }
    async handle(job) {
        const executionId = job.data.executionId;
        if (!executionId) {
            logger.warn('Scheduler job missing executionId');
            return;
        }
        const execution = await this.executionRepo.findById(executionId);
        if (!execution) {
            logger.warn({ executionId }, 'Execution disappeared before scheduling');
            return;
        }
        if (execution.status !== 'queued') {
            logger.info({ executionId, status: execution.status }, 'Execution already processed');
            return;
        }
        const hasConflict = await this.executionRepo.hasSchedulingConflict(execution);
        if (hasConflict) {
            await this.executionRepo.appendLog({
                executionId,
                stream: 'system',
                message: `Scheduling conflict for type=${execution.type}, execution requeued`
            });
            await this.schedulerQueue.add('schedule', { executionId }, { delay: lockConfig.retryDelayMs, removeOnComplete: true, removeOnFail: true });
            return;
        }
        const lockKey = execution.lockKey;
        const acquired = await this.lockService.acquire(lockKey, executionId, lockConfig.ttlMs);
        if (!acquired) {
            logger.debug({ executionId, lockKey }, 'Lock busy, deferring execution');
            await this.executionRepo.appendLog({
                executionId,
                stream: 'system',
                message: `Lock ${lockKey} is busy, execution requeued`
            });
            await this.schedulerQueue.add('schedule', { executionId }, { delay: lockConfig.retryDelayMs, removeOnComplete: true, removeOnFail: true });
            return;
        }
        await this.executionRepo.updateStatus(executionId, 'scheduled');
        await this.executionRepo.appendLog({
            executionId,
            stream: 'system',
            message: 'Execution scheduled and sent to launcher'
        });
        await this.launcherQueue.add('launch', { executionId }, { removeOnComplete: true, removeOnFail: false });
        logger.info({ executionId }, 'Execution promoted to launcher queue');
    }
}
