import { createClient } from 'redis';
import { redisConnectionOptions } from '../config/redis.js';
import { startVmPoolManager } from './poolManager.js';

const WORKER_NAME = 'pool-manager';
const CONTROL_CHANNEL = `control:${WORKER_NAME}`;
const STATUS_KEY = `worker:${WORKER_NAME}`;

(async () => {
  const connection = redisConnectionOptions();
  const manager = startVmPoolManager({});
  console.log('VM pool manager started');

  const redisClient = createClient({
    socket: { host: connection.host, port: connection.port },
    password: connection.password
  });
  await redisClient.connect();

  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  let currentStatus = 'running';

  const updateStatus = async status => {
    currentStatus = status;
    await redisClient.hSet(STATUS_KEY, {
      status,
      lastHeartbeat: Date.now().toString()
    });
    await redisClient.expire(STATUS_KEY, 15);
  };

  const heartbeat = setInterval(() => updateStatus(currentStatus), 5000);
  await updateStatus(currentStatus);

  await subscriber.subscribe(CONTROL_CHANNEL, async message => {
    if (message === 'pause') {
      manager.pause();
      await updateStatus('paused');
      console.log('VM pool manager paused by dashboard');
    } else if (message === 'resume') {
      manager.resume();
      await updateStatus('running');
      console.log('VM pool manager resumed by dashboard');
    } else if (message === 'run-now') {
      await manager.runNow();
      console.log('VM pool manager run requested by dashboard');
    }
  });

  const stop = async () => {
    clearInterval(heartbeat);
    console.log('Stopping VM pool manager...');
    await subscriber.unsubscribe(CONTROL_CHANNEL);
    await subscriber.disconnect();
    await redisClient.hSet(STATUS_KEY, { status: 'stopped', lastHeartbeat: Date.now().toString() });
    await manager.close();
    await redisClient.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
})();
