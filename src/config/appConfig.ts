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
  schedulerQueueName: process.env.SCHEDULER_QUEUE_NAME ?? 'execution-scheduler',
  launcherQueueName: process.env.LAUNCHER_QUEUE_NAME ?? 'execution-launcher'
};

export const kubernetesConfig = {
  namespace: process.env.K8S_NAMESPACE ?? 'labfactory',
  terraformRunnerImage: process.env.TERRAFORM_RUNNER_IMAGE ?? 'labfactory/terraform-runner:latest',
  ansibleRunnerImage: process.env.ANSIBLE_RUNNER_IMAGE ?? 'labfactory/ansible-runner:latest',
  serviceAccount: process.env.K8S_SERVICE_ACCOUNT ?? 'labfactory-runner-job'
};

export const lockConfig = {
  ttlMs: parseNumber(process.env.LOCK_TTL_MS, 12 * 60 * 60 * 1000),
  retryDelayMs: parseNumber(process.env.LOCK_RETRY_DELAY_MS, 5000)
};

export const launcherConfig = {
  pollIntervalMs: parseNumber(process.env.LAUNCHER_POLL_INTERVAL_MS, 5000),
  jobTimeoutMs: parseNumber(process.env.LAUNCHER_JOB_TIMEOUT_MS, 30 * 60 * 1000)
};

export const artifactConfig = {
  storageAdapter: process.env.ARTIFACT_STORAGE_ADAPTER ?? 'filesystem',
  baseUri: process.env.ARTIFACT_BASE_URI ?? 'file://./artifacts'
};
