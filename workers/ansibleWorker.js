import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import { runCommand } from '../lib/runCommand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ansibleDir = path.resolve(__dirname, '../ansible');
const isWindowsOsType = osType => ['windows11', 'windows-server'].includes(String(osType ?? '').trim());
const isLinuxOsType = osType => !isWindowsOsType(osType);
const getWindowsAdminUsername = language =>
  (String(language ?? '').trim().toLowerCase() === 'fr' ? 'Administrateur' : 'Administrator');
const linuxPlaybookPath = path.join(ansibleDir, 'linux-playbook.yml');
const windowsPlaybookPath = path.join(ansibleDir, 'windows-playbook.yml');
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

const buildWindowsInventoryHosts = ({ windowsAdminPassword, timezoneTargets }) => {
  const hosts = timezoneTargets
    .map((target, index) => {
      const hostName = `vm_${index + 1}`;
      const windowsAdminUsername =
        String(target.windowsAdminUsername ?? '').trim() || getWindowsAdminUsername(target.language);
      const lines = [
        `        ${hostName}:`,
        `          ansible_host: ${target.ipAddress}`,
        `          ansible_user: ${JSON.stringify(windowsAdminUsername)}`,
        `          ansible_password: ${JSON.stringify(windowsAdminPassword)}`,
        '          ansible_connection: winrm',
        '          ansible_port: 5986',
        '          ansible_winrm_scheme: https',
        '          ansible_winrm_transport: basic',
        '          ansible_winrm_server_cert_validation: ignore',
        `          target_vm_name: ${JSON.stringify(target.name ?? hostName)}`
      ];
      if (String(target.timezone ?? '').trim()) {
        lines.push(`          target_timezone: ${JSON.stringify(target.timezone)}`);
      }
      if (String(target.hostname ?? '').trim()) {
        lines.push(`          target_hostname: ${JSON.stringify(target.hostname)}`);
      }
      return lines.join('\n');
    })
    .join('\n');

  return `    windows_timezone_targets:
      hosts:
${hosts}`;
};

const buildLinuxInventoryHosts = ({ linuxUser, linuxPassword, timezoneTargets }) => {
  const hosts = timezoneTargets
    .map((target, index) => {
      const hostName = `linux_vm_${index + 1}`;
      const lines = [
        `        ${hostName}:`,
        `          ansible_host: ${target.ipAddress}`,
        `          ansible_user: ${JSON.stringify(linuxUser)}`,
        '          ansible_connection: ssh',
        '          ansible_ssh_common_args: "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"',
        '          ansible_become: true',
        `          ansible_password: ${JSON.stringify(linuxPassword)}`,
        `          ansible_become_password: ${JSON.stringify(linuxPassword)}`,
        `          target_vm_name: ${JSON.stringify(target.name ?? hostName)}`
      ];
      if (String(target.timezone ?? '').trim()) {
        lines.push(`          target_timezone: ${JSON.stringify(target.timezone)}`);
      }
      if (String(target.hostname ?? '').trim()) {
        lines.push(`          target_hostname: ${JSON.stringify(target.hostname)}`);
      }
      return lines.join('\n');
    })
    .join('\n');

  return `    linux_timezone_targets:
      hosts:
${hosts}`;
};

export function startAnsibleWorker(connection) {
  const activeAbortControllers = new Map();

  const worker = new Worker(
    ansibleQueueName,
    async job => {
      const abortController = new AbortController();
      activeAbortControllers.set(String(job.id), abortController);
      const deploymentLabel = job.data.deploymentNumber ? `#${job.data.deploymentNumber}` : String(job.data.deploymentId ?? job.id);
      const extraVars = {
        lab_instance_id: job.data.labInstanceId ?? 'lab-demo',
        deployment_id: job.data.deploymentId ?? null,
        run_id: job.data.runId,
        terraform_status: 'apply-complete',
        timezone_targets: Array.isArray(job.data.timezoneTargets) ? job.data.timezoneTargets : [],
        linux_default_username: String(job.data.linuxDefaultUsername ?? '').trim() || 'ubuntu',
        windows_admin_password: String(job.data.windowsAdminPassword ?? '').trim() || null
      };

      try {
        console.log(`Ansible job ${job.id} started for deployment ${deploymentLabel} (customize)`);
        const windowsTimezoneTargets = extraVars.timezone_targets.filter(
          target =>
            target &&
            target.ipAddress &&
            (target.timezone || target.hostname) &&
            ['windows11', 'windows-server'].includes(String(target.osType ?? ''))
        );
        const linuxTimezoneTargets = extraVars.timezone_targets.filter(
          target =>
            target &&
            target.ipAddress &&
            (target.timezone || target.hostname) &&
            isLinuxOsType(target.osType)
        );
        if (!windowsTimezoneTargets.length && !linuxTimezoneTargets.length) {
          await safeUpdateDeploymentStatus(job.data.deploymentId, 'deployed', {
            action: 'customize',
            jobId: String(job.id),
            runId: job.data.runId
          });
          return { status: 'ansible-skipped', extraVars };
        }

        const inventoryPath = path.join(ansibleDir, `.inventory-${job.id}.yml`);
        const inventoryParts = [];

        if (windowsTimezoneTargets.length) {
          if (!extraVars.windows_admin_password) {
            throw new Error('windows_admin_password is required for Windows timezone customization');
          }
          inventoryParts.push(
            buildWindowsInventoryHosts({
              windowsAdminPassword: extraVars.windows_admin_password,
              timezoneTargets: windowsTimezoneTargets
            })
          );
        }

        if (linuxTimezoneTargets.length) {
          const linuxUser = extraVars.linux_default_username;
          const linuxPassword = extraVars.windows_admin_password;

          if (!linuxUser) {
            throw new Error('linux_default_username is required for Linux guest customization');
          }
          if (!linuxPassword) {
            throw new Error('A lab password is required for Linux guest customization');
          }

          inventoryParts.push(
            buildLinuxInventoryHosts({
              linuxUser,
              linuxPassword,
              timezoneTargets: linuxTimezoneTargets
            })
          );
        }

        await fs.writeFile(
          inventoryPath,
          `all:\n  children:\n${inventoryParts.join('\n')}\n`,
          'utf8'
        );

        await safeUpdateDeploymentStatus(job.data.deploymentId, 'customizing', {
          action: 'customize',
          jobId: String(job.id),
          runId: job.data.runId
        });

        try {
          const commonArgs = ['--inventory', inventoryPath, '--extra-vars', JSON.stringify(extraVars)];

          if (linuxTimezoneTargets.length) {
            await runCommand(
              'ansible-playbook',
              [linuxPlaybookPath, ...commonArgs],
              {
                cwd: ansibleDir,
                env: { ...process.env },
                signal: abortController.signal
              }
            );
          }

          if (windowsTimezoneTargets.length) {
            await runCommand(
              'ansible-playbook',
              [windowsPlaybookPath, ...commonArgs],
              {
                cwd: ansibleDir,
                env: { ...process.env },
                signal: abortController.signal
              }
            );
          }
        } finally {
          await fs.rm(inventoryPath, { force: true });
        }

        await safeUpdateDeploymentStatus(job.data.deploymentId, 'deployed', {
          action: 'customize',
          jobId: String(job.id),
          runId: job.data.runId
        });

        console.log(`Ansible job ${job.id} finished for deployment ${deploymentLabel} (customize)`);
        return { status: 'ansible-done', extraVars };
      } catch (error) {
        console.error(`Ansible job ${job.id} failed for deployment ${deploymentLabel} (customize)`, error);
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
