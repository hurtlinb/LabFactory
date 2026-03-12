import { createClient } from 'redis';
import { redisConfig } from '../../config/appConfig.js';
import { logger } from '../logging/logger.js';

export const createRedisClient = (): ReturnType<typeof createClient> => {
  const client = createClient({
    socket: { host: redisConfig.host, port: redisConfig.port },
    password: redisConfig.password
  });

  client.on('error', err => {
    logger.error({ err }, 'Redis client error');
  });

  return client;
};
