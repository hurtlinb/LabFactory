import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Queue } = require('bullmq');
import { redisConnectionOptions } from './config/redis.js';
import { terraformQueueName, startTerraformWorker } from './workers/terraformWorker.js';
import { ansibleQueueName, startAnsibleWorker } from './workers/ansibleWorker.js';
import { waitForJobCompletion } from './lib/jobMonitor.js';

async function runDemo() {
  const connection = redisConnectionOptions();

  const terraformQueue = new Queue(terraformQueueName, { connection });
  const ansibleQueue = new Queue(ansibleQueueName, { connection });
  const terraformWorker = startTerraformWorker(connection);
  const ansibleWorker = startAnsibleWorker(connection);

  const jobData = {
    labInstanceId: 'lab-demo-001',
    runId: `demo-${Date.now()}`
  };

  try {
    const terraformJob = await terraformQueue.add('apply', jobData, {
      attempts: 2,
      removeOnComplete: true,
      removeOnFail: false
    });
    console.log('Terraform job queued:', terraformJob.id);

    const planResult = await waitForJobCompletion(terraformQueue, terraformJob.id);
    console.log('Terraform job finished, payload:', planResult);

    const ansibleJob = await ansibleQueue.add('provision', {
      ...jobData,
      planOutput: planResult?.planOutput
    });
    console.log('Ansible job queued:', ansibleJob.id);

    const ansibleResult = await waitForJobCompletion(ansibleQueue, ansibleJob.id);
    console.log('Ansible job result:', ansibleResult);
  } finally {
    await Promise.allSettled([
      terraformQueue.close(),
      ansibleQueue.close(),
      terraformWorker.close(),
      ansibleWorker.close()
    ]);
  }
}

runDemo().catch(err => {
  console.error('Demo workflow failed:', err);
  process.exit(1);
});
