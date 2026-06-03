import { Queue } from 'bullmq';
import { redisConfig, queueConfig } from '../../config/appConfig.js';
const connection = {
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password
};
export const schedulerQueue = new Queue(queueConfig.schedulerQueueName, { connection });
export const launcherQueue = new Queue(queueConfig.launcherQueueName, { connection });
