import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { runCommand } from '../lib/runCommand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ansibleDir = path.resolve(__dirname, '../ansible');
const playbookPath = path.join(ansibleDir, 'playbook.yml');

export const ansibleQueueName = 'ansible-workflows';

export function startAnsibleWorker(connection) {
  return new Worker(
    ansibleQueueName,
    async job => {
      const extraVars = {
        lab_instance_id: job.data.labInstanceId ?? 'lab-demo',
        run_id: job.data.runId,
        terraform_status: job.data.planOutput ? 'apply-complete' : 'unknown'
      };

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
          env: { ...process.env }
        }
      );

      return { status: 'ansible-done', extraVars };
    },
    { connection, concurrency: 1 }
  );
}
