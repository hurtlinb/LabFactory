import { v4 as uuidv4 } from 'uuid';
import { createRedisClient } from '../../infrastructure/redis/client.js';
import { logger } from '../../infrastructure/logging/logger.js';

const LOCK_PREFIX = 'execution-lock:';

export class LockService {
  constructor(private client: ReturnType<typeof createRedisClient> = createRedisClient()) {}

  async connect() {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async disconnect() {
    if (this.client.isOpen) {
      await this.client.disconnect();
    }
  }

  private key(lockKey: string) {
    return `${LOCK_PREFIX}${lockKey}`;
  }

  async acquire(lockKey: string, executionId: string, ttlMs: number): Promise<boolean> {
    const namespaced = this.key(lockKey);
    const lockValue = `${executionId}:${uuidv4()}`;
    const result = await this.client.set(namespaced, lockValue, { NX: true, PX: ttlMs });
    const granted = result === 'OK';
    logger.debug({ lockKey, executionId, granted }, 'Lock acquisition attempt');
    return granted;
  }

  async release(lockKey: string, executionId: string) {
    const namespaced = this.key(lockKey);
    const script =
      "local v=redis.call('get', KEYS[1]); if not v then return 0 end; if string.sub(v,1,string.len(ARGV[1]))==ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await this.client.eval(script, { keys: [namespaced], arguments: [executionId] });
    logger.debug({ lockKey, executionId }, 'Released execution lock');
  }
}
