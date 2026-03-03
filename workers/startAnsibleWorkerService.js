import { createClient } from 'redis';
import { redisConnectionOptions } from '../config/redis.js';
import { startAnsibleWorker } from './ansibleWorker.js';

const WORKER_NAME = 'ansible';
const CONTROL_CHANNEL = `control:${WORKER_NAME}`;
const STATUS_KEY = `worker:${WORKER_NAME}`;

(async () => {
  const connection = redisConnectionOptions();
  const worker = startAnsibleWorker(connection);
  console.log('Ansible worker started');

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
      await worker.pause();
      await updateStatus('paused');
      console.log('Ansible worker paused by dashboard');
    } else if (message === 'resume') {
      await worker.resume();
      await updateStatus('running');
      console.log('Ansible worker resumed by dashboard');
    }
  });

  const stop = async () => {
    clearInterval(heartbeat);
    console.log('Stopping Ansible worker...');
    await subscriber.unsubscribe(CONTROL_CHANNEL);
    await subscriber.disconnect();
    await redisClient.hSet(STATUS_KEY, { status: 'stopped', lastHeartbeat: Date.now().toString() });
    await worker.close();
    await redisClient.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
})();
