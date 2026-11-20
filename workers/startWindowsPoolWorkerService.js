import os from 'node:os';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { redisConnectionOptions } from '../config/redis.js';
import { readTerraformEnvSettings } from '../lib/terraformSettings.js';
import { createHttpRequest, createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';

// Windows pool worker (lot P2): feeds the pool in the background, outside BullMQ and
// without the global Terraform lock. Several replicas may run: coordination goes
// through PostgreSQL (per-VM locks, versions, distributed leases).

const WORKER_NAME = 'windows-pool';
const CONTROL_CHANNEL = `control:${WORKER_NAME}`;
const STATUS_KEY = `worker:${WORKER_NAME}`;
const TICK_MS = Math.max(1_000, Number(process.env.WINDOWS_POOL_TICK_MS ?? 5_000));
const SHUTDOWN_GRACE_MS = Math.max(5_000, Number(process.env.WINDOWS_POOL_SHUTDOWN_GRACE_MS ?? 120_000));

(async () => {
  const env = readTerraformEnvSettings();
  const db = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory',
    max: Math.max(10, Number(process.env.WINDOWS_POOL_DB_POOL_SIZE ?? 20))
  });
  const proxmox = createPoolProxmox(createHttpRequest({
    apiUrl: env.proxmox_api_url,
    tokenId: env.proxmox_api_token_id,
    tokenSecret: env.proxmox_api_token_secret,
    tlsInsecure: env.proxmox_tls_insecure
  }));
  const holder = `${os.hostname()}:${process.pid}`;
  const manager = createPoolManager({ db, proxmox, holder });

  const connection = redisConnectionOptions();
  const redisClient = createClient({ socket: { host: connection.host, port: connection.port }, password: connection.password });
  await redisClient.connect();
  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  let status = 'running';
  let stopping = false;
  let ticking = null;
  const updateStatus = async next => {
    status = next;
    await redisClient.hSet(STATUS_KEY, { status, lastHeartbeat: Date.now().toString() });
    await redisClient.expire(STATUS_KEY, 15);
  };
  const heartbeat = setInterval(() => updateStatus(status).catch(() => undefined), 5_000);
  await updateStatus(status);

  // Pause: no new operation is started; the ones in progress finish
  // (a Proxmox task is never interrupted).
  await subscriber.subscribe(CONTROL_CHANNEL, async message => {
    if (message === 'pause') { await updateStatus('paused'); console.log('Windows pool worker paused'); }
    if (message === 'resume') { await updateStatus('running'); console.log('Windows pool worker resumed'); }
  });

  const loop = async () => {
    while (!stopping) {
      if (status === 'running') {
        ticking = manager.tick().catch(error => console.error(`[windows-pool] tick: ${error.message}`));
        await ticking;
        ticking = null;
      }
      await new Promise(resolve => setTimeout(resolve, TICK_MS));
    }
  };
  console.log(`Windows pool worker started (${holder}, tick ${TICK_MS} ms)`);
  loop();

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    console.log('Stopping Windows pool worker: waiting for running operations...');
    await ticking;
    // Every step is resumable (checkpoints + UPID): past the grace period, a later
    // restart resumes the interrupted operations without restarting them blindly.
    await Promise.race([manager.drain(), new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
    await subscriber.unsubscribe(CONTROL_CHANNEL).catch(() => undefined);
    await subscriber.disconnect().catch(() => undefined);
    await redisClient.hSet(STATUS_KEY, { status: 'stopped', lastHeartbeat: Date.now().toString() }).catch(() => undefined);
    await redisClient.disconnect().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch(error => {
  console.error(`Windows pool worker failed to start: ${error.message}`);
  process.exit(1);
});
