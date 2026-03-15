import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import { runCommand } from '../lib/runCommand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ansibleDir = path.resolve(__dirname, '../ansible');
const playbookPath = path.join(ansibleDir, 'playbook.yml');
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory'
});

export const ansibleQueueName = 'ansible-workflows';

const updateDeploymentStatus = async (deploymentId, status, details = {}) => {
  if (!deploymentId) return;
  await dbPool.query(
    `UPDATE lab_deployments
     SET
       status = $2,
       last_action = $3,
       last_job_id = $4,
       last_run_id = $5,
       updated_at = NOW()
     WHERE id = $1`,
    [deploymentId, status, details.action ?? 'customize', details.jobId ?? null, details.runId ?? null]
  );
};

const safeUpdateDeploymentStatus = async (deploymentId, status, details = {}) => {
  try {
    await updateDeploymentStatus(deploymentId, status, details);
  } catch (error) {
    console.error(`Unable to update deployment status to ${status} for ${deploymentId}`, error);
  }
};

const buildWindowsInventory = ({ windowsAdminPassword, timezoneTargets }) => {
  const hosts = timezoneTargets
    .map((target, index) => {
      const hostName = `vm_${index + 1}`;
      return `        ${hostName}:
          ansible_host: ${target.ipAddress}
          ansible_user: Administrator
          ansible_password: ${JSON.stringify(windowsAdminPassword)}
          ansible_connection: winrm
          ansible_port: 5986
          ansible_winrm_scheme: https
          ansible_winrm_transport: basic
          ansible_winrm_server_cert_validation: ignore
          target_timezone: ${JSON.stringify(target.timezone)}
          target_vm_name: ${JSON.stringify(target.name ?? hostName)}`;
    })
    .join('\n');

  return `all:
  children:
    windows_timezone_targets:
      hosts:
${hosts}
`;
};

export function startAnsibleWorker(connection) {
  const activeAbortControllers = new Map();

  const worker = new Worker(
    ansibleQueueName,
    async job => {
      const abortController = new AbortController();
      activeAbortControllers.set(String(job.id), abortController);
      const extraVars = {
        lab_instance_id: job.data.labInstanceId ?? 'lab-demo',
        deployment_id: job.data.deploymentId ?? null,
        run_id: job.data.runId,
        terraform_status: 'apply-complete',
        timezone_targets: Array.isArray(job.data.timezoneTargets) ? job.data.timezoneTargets : [],
        windows_admin_password: String(job.data.windowsAdminPassword ?? '').trim() || null
      };

      try {
        if (!extraVars.windows_admin_password) {
          throw new Error('windows_admin_password is required for timezone customization');
        }

        const timezoneTargets = extraVars.timezone_targets.filter(
          target => target && target.ipAddress && target.timezone && ['windows11', 'windows-server'].includes(String(target.osType ?? ''))
        );
        if (!timezoneTargets.length) {
          await safeUpdateDeploymentStatus(job.data.deploymentId, 'deployed', {
            action: 'customize',
            jobId: String(job.id),
            runId: job.data.runId
          });
          return { status: 'ansible-skipped', extraVars };
        }

        const inventoryPath = path.join(ansibleDir, `.inventory-${job.id}.yml`);
        await fs.writeFile(
          inventoryPath,
          buildWindowsInventory({
            windowsAdminPassword: extraVars.windows_admin_password,
            timezoneTargets
          }),
          'utf8'
        );

        await safeUpdateDeploymentStatus(job.data.deploymentId, 'customizing', {
          action: 'customize',
          jobId: String(job.id),
          runId: job.data.runId
        });

        try {
          await runCommand(
            'ansible-playbook',
            [
              playbookPath,
              '--inventory',
              inventoryPath,
              '--extra-vars',
              JSON.stringify(extraVars)
            ],
            {
              cwd: ansibleDir,
              env: { ...process.env },
              signal: abortController.signal
            }
          );
        } finally {
          await fs.rm(inventoryPath, { force: true });
        }

        await safeUpdateDeploymentStatus(job.data.deploymentId, 'deployed', {
          action: 'customize',
          jobId: String(job.id),
          runId: job.data.runId
        });

        return { status: 'ansible-done', extraVars };
      } catch (error) {
        await safeUpdateDeploymentStatus(job.data.deploymentId, 'failed', {
          action: 'customize',
          jobId: String(job.id),
          runId: job.data.runId
        });
        throw error;
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
