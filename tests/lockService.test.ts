import { describe, it, expect, beforeEach } from 'vitest';
import { LockService } from '../src/application/locking/lockService';

class InMemoryRedis {
  private store = new Map<string, string>();
  isOpen = true;

  async set(key: string, value: string, opts: { NX?: boolean; PX?: number }) {
    if (opts.NX && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return 'OK';
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    const stored = this.store.get(options.keys[0]);
    if (stored && stored.startsWith(options.arguments[0])) {
      this.store.delete(options.keys[0]);
      return 1;
    }
    return 0;
  }

  async connect() {
    this.isOpen = true;
  }

  async disconnect() {
    this.isOpen = false;
  }
}

describe('LockService', () => {
  let redis: InMemoryRedis;
  let service: LockService;

  beforeEach(() => {
    redis = new InMemoryRedis();
    service = new LockService(redis as any);
  });

  it('grants lock once and defers second request', async () => {
    await service.connect();
    const first = await service.acquire('key', 'exec-1', 1000);
    expect(first).toBe(true);

    const second = await service.acquire('key', 'exec-2', 1000);
    expect(second).toBe(false);
  });

  it('releases lock when ownership matches', async () => {
    await service.connect();
    await service.acquire('key', 'exec-3', 1000);
    await service.release('key', 'exec-3');
    const reacquire = await service.acquire('key', 'exec-4', 1000);
    expect(reacquire).toBe(true);
  });
});
