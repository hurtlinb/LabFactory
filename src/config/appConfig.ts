import dotenv from 'dotenv';

dotenv.config();

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const appConfig = {
  port: parseNumber(process.env.PORT, 3000),
  env: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? 'info'
};

export const dbConfig = {
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://labfactory:labfactory@localhost:5432/labfactory'
};

export const redisConfig = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseNumber(process.env.REDIS_PORT, 6379),
  password: process.env.REDIS_PASSWORD ?? undefined
};

export const queueConfig = {
  schedulerQueueName: process.env.SCHEDULER_QUEUE_NAME ?? 'execution-scheduler'
};
