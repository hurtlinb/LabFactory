import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { runCommand } from '../lib/runCommand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ansibleDir = path.resolve(__dirname, '../ansible');
const playbookPath = path.join(ansibleDir, 'playbook.yml');

export const ansibleQueueName = 'ansible-workflows';

export function startAnsibleWorker(connection) {
  const activeAbortControllers = new Map();

  const worker = new Worker(
    ansibleQueueName,
    async job => {
      const abortController = new AbortController();
      activeAbortControllers.set(String(job.id), abortController);
      const extraVars = {
        lab_instance_id: job.data.labInstanceId ?? 'lab-demo',
        run_id: job.data.runId,
        terraform_status: job.data.planOutput ? 'apply-complete' : 'unknown'
      };

      try {
        await runCommand(
          'ansible-playbook',
          [
            playbookPath,
            '--inventory',
            'localhost,',
            '--connection',
            'local',
            '--extra-vars',
            JSON.stringify(extraVars)
          ],
          {
            cwd: ansibleDir,
            env: { ...process.env },
            signal: abortController.signal
          }
        );

        return { status: 'ansible-done', extraVars };
      } finally {
        activeAbortControllers.delete(String(job.id));
      }
    },
    { connection, concurrency: 1 }
  );

  worker.cancelActiveJobs = async () => {
    for (const controller of activeAbortControllers.values()) {
      controller.abort(new Error('Job cancelled from dashboard clear history action'));
    }
  };

  return worker;
}
