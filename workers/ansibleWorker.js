import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Queue, Worker } from 'bullmq';
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
const windowsDomainPlaybookPath = path.join(ansibleDir, 'windows-domain-playbook.yml');
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory'
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WINDOWS_RECONNECT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
// Covers a whole batch per round (not a single host) — see the same lesson learned today in
// terraformWorker.js's readiness check: too short here means the slowest/unreachable host in the
// round kills the ansible-playbook process before the marker-writing task ever runs for anyone.
const WINDOWS_RECONNECT_ATTEMPT_TIMEOUT_SECONDS = 180;
const RECONNECT_RETRY_BACKOFF_STEPS = [
  { afterMs: 0, delayMs: 5000 },
  { afterMs: 60 * 1000, delayMs: 15000 },
  { afterMs: 5 * 60 * 1000, delayMs: 30000 }
];
const computeReconnectRetryDelayMs = elapsedMs => {
  let delayMs = RECONNECT_RETRY_BACKOFF_STEPS[0].delayMs;
  for (const step of RECONNECT_RETRY_BACKOFF_STEPS) {
    if (elapsedMs >= step.afterMs) {
      delayMs = step.delayMs;
    }
  }
  return delayMs;
};

const windowsReconnectCheckPlaybook = `- name: Wait for Windows guests to reconnect after reboot
  hosts: windows_reconnect_targets
  gather_facts: false
  strategy: free
  tasks:
    - name: Ping WinRM
      ansible.windows.win_ping:
      ignore_errors: true
      register: win_ping_result

    - name: Record per-host reconnect marker
      ansible.builtin.copy:
        content: "ready"
        dest: "{{ marker_dir }}/{{ inventory_hostname }}"
        mode: '0644'
      delegate_to: localhost
      when: win_ping_result is succeeded
`;

const buildWindowsReconnectInventory = (targets, password) => {
  const hosts = targets
    .map(target => [
      `        vm_${target.vmid}:`,
      `          ansible_host: ${JSON.stringify(target.ipAddress)}`,
      `          ansible_user: ${JSON.stringify(String(target.windowsAdminUsername ?? '').trim() || getWindowsAdminUsername(target.language))}`,
      `          ansible_password: ${JSON.stringify(password)}`,
      '          ansible_connection: winrm',
      '          ansible_port: 5986',
      '          ansible_winrm_scheme: https',
      '          ansible_winrm_transport: basic',
      '          ansible_winrm_server_cert_validation: ignore',
      '          ansible_winrm_operation_timeout_sec: 8',
      '          ansible_winrm_read_timeout_sec: 12'
    ].join('\n'))
    .join('\n');

  return `all:
  children:
    windows_reconnect_targets:
      hosts:
${hosts}
`;
};

// Round-based reconnect check: every still-pending VM is pinged in ONE ansible-playbook run per
// round (Ansible's own forking handles the parallelism), so a slow/unreachable VM never blocks
// others from being checked or reported — same fix shape as waitForWindowsBatchReadiness in
// terraformWorker.js, kept separate/duplicated rather than shared given how recently that one was
// stabilized. Unlike that one, a single successful ping is enough (no stability recheck needed).
const waitForWindowsReconnect = async ({ targets, password, signal, onHostReady }) => {
  if (!targets.length) {
    return;
  }

  const startedAt = Date.now();
  const baseDir = path.join(tmpdir(), `labfactory-windows-reconnect-${process.pid}-${Date.now()}`);
  await fs.mkdir(baseDir, { recursive: true });

  const pending = new Map(targets.map(target => [Number(target.vmid), target]));
  let lastError = null;
  let roundIndex = 0;

  try {
    while (pending.size > 0) {
      if (Date.now() - startedAt >= WINDOWS_RECONNECT_WAIT_TIMEOUT_MS) {
        const stillPending = Array.from(pending.values()).map(target => target.name).join(', ');
        throw new Error(
          `Timed out waiting for Windows guests to reconnect after reboot: ${stillPending}${lastError ? ` (last error: ${lastError.message})` : ''}`
        );
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Windows reconnect wait aborted');
      }

      const roundDir = path.join(baseDir, String(roundIndex));
      const inventoryPath = path.join(baseDir, `round-${roundIndex}.yml`);
      const playbookPath = path.join(baseDir, `round-${roundIndex}.playbook.yml`);
      await fs.mkdir(roundDir, { recursive: true });
      await fs.writeFile(inventoryPath, buildWindowsReconnectInventory(Array.from(pending.values()), password), 'utf8');
      await fs.writeFile(playbookPath, windowsReconnectCheckPlaybook, 'utf8');

      try {
        await runCommand(
          'timeout',
          [
            `${WINDOWS_RECONNECT_ATTEMPT_TIMEOUT_SECONDS}s`,
            'ansible-playbook',
            '--inventory',
            inventoryPath,
            '--extra-vars',
            JSON.stringify({ marker_dir: roundDir }),
            playbookPath
          ],
          { cwd: ansibleDir, env: { ...process.env }, signal }
        );
      } catch (error) {
        lastError = error;
      }

      let readyHostKeys;
      try {
        readyHostKeys = new Set(await fs.readdir(roundDir));
      } catch {
        readyHostKeys = new Set();
      }

      for (const vmid of [...pending.keys()]) {
        if (readyHostKeys.has(`vm_${vmid}`)) {
          const target = pending.get(vmid);
          pending.delete(vmid);
          await onHostReady(target);
        }
      }

      await Promise.all([
        fs.rm(roundDir, { recursive: true, force: true }),
        fs.rm(inventoryPath, { force: true }),
        fs.rm(playbookPath, { force: true })
      ]);

      if (pending.size === 0) {
        break;
      }
      roundIndex += 1;
      await sleep(computeReconnectRetryDelayMs(Date.now() - startedAt));
    }
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
};

const createCustomizationReconnectReporter = (job, targetVmids) => {
  const targetVmidSet = new Set(targetVmids.map(Number));
  const reconnectedVmids = new Set();

  const publish = async () => {
    await job.updateProgress({
      type: 'customization-reconnect',
      targetVmids: Array.from(targetVmidSet).sort((a, b) => a - b),
      reconnectedVmids: Array.from(reconnectedVmids).sort((a, b) => a - b)
    });
  };

  return {
    markReconnected: async vmid => {
      const numericVmid = Number(vmid);
      if (targetVmidSet.has(numericVmid)) {
        reconnectedVmids.add(numericVmid);
      }
      await publish();
    }
  };
};

export const ansibleQueueName = 'ansible-workflows';

const updateDeploymentStatus = async (deploymentId, status, details = {}) => {
  if (!deploymentId) return false;
  const expectedRunId = details.runId == null ? null : String(details.runId);
  const result = await dbPool.query(
    `UPDATE lab_deployments
     SET
       status = $2,
       last_action = $3,
       last_job_id = $4,
       last_run_id = $5,
       updated_at = NOW()
     WHERE id = $1
       AND ($6::text IS NULL OR last_run_id = $6)
     RETURNING id`,
    [deploymentId, status, details.action ?? 'customize', details.jobId ?? null, details.runId ?? null, expectedRunId]
  );
  return result.rowCount > 0;
};

const safeUpdateDeploymentStatus = async (deploymentId, status, details = {}) => {
  try {
    const updated = await updateDeploymentStatus(deploymentId, status, details);
    if (!updated && deploymentId) {
      console.warn(
        `Skipping stale deployment status update to ${status} for ${deploymentId} (runId=${details.runId ?? 'n/a'})`
      );
    }
    return updated;
  } catch (error) {
    console.error(`Unable to update deployment status to ${status} for ${deploymentId}`, error);
    return false;
  }
};

const buildWindowsInventoryHosts = ({ windowsAdminPassword, timezoneTargets, allTargets = [] }) => {
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
      if (target.secondDiskSizeGb) {
        lines.push(`          second_disk_size_gb: ${Number(target.secondDiskSizeGb)}`);
        lines.push(`          second_disk_configure: ${Boolean(target.secondDiskConfigure)}`);
      }
      if (String(target.domainRole ?? '').trim()) {
        lines.push(`          domain_role: ${JSON.stringify(target.domainRole)}`);
      }
      if (String(target.domainName ?? '').trim()) {
        lines.push(`          domain_name: ${JSON.stringify(target.domainName)}`);
      }
      if (target.domainRole === 'member' && target.domainName && target.ipAddress) {
        const subnet = target.ipAddress.split('.').slice(0, 3).join('.');
        const dc = allTargets.find(t =>
          t.domainRole === 'controller' &&
          t.domainName === target.domainName &&
          t.ipAddress?.startsWith(subnet + '.')
        );
        if (dc?.ipAddress) {
          lines.push(`          domain_controller_ip: ${JSON.stringify(dc.ipAddress)}`);
          const dcAdminUsername = String(dc.windowsAdminUsername ?? '').trim() || getWindowsAdminUsername(dc.language);
          lines.push(`          domain_admin_username: ${JSON.stringify(dcAdminUsername)}`);
        }
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
      if (target.installDocker) {
        lines.push(`          install_docker: true`);
      }
      if (target.secondDiskSizeGb) {
        lines.push(`          second_disk_size_gb: ${Number(target.secondDiskSizeGb)}`);
        lines.push(`          second_disk_configure: ${Boolean(target.secondDiskConfigure)}`);
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
  const ansibleQueue = new Queue(ansibleQueueName, { connection });

  const worker = new Worker(
    ansibleQueueName,
    async job => {
      const abortController = new AbortController();
      activeAbortControllers.set(String(job.id), abortController);
      const deploymentLabel = job.data.deploymentNumber ? `#${job.data.deploymentNumber}` : String(job.data.deploymentId ?? job.id);
      const blueprintWindowsAdminPassword = String(job.data?.blueprint?.windowsAdminPassword ?? '').trim() || null;
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
        if (extraVars.windows_admin_password !== blueprintWindowsAdminPassword) {
          throw new Error('Ansible customization password does not match blueprint windowsAdminPassword');
        }
        const windowsTimezoneTargets = extraVars.timezone_targets.filter(
          target =>
            target &&
            target.ipAddress &&
            (target.timezone || target.hostname || target.domainRole || (target.secondDiskSizeGb && target.secondDiskConfigure)) &&
            ['windows11', 'windows-server'].includes(String(target.osType ?? ''))
        );
        const linuxTimezoneTargets = extraVars.timezone_targets.filter(
          target =>
            target &&
            target.ipAddress &&
            (target.timezone || target.hostname || target.installDocker || (target.secondDiskSizeGb && target.secondDiskConfigure)) &&
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
              timezoneTargets: windowsTimezoneTargets,
              allTargets: extraVars.timezone_targets
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

        const statusClaimed = await safeUpdateDeploymentStatus(job.data.deploymentId, 'customizing', {
          action: 'customize',
          jobId: String(job.id),
          runId: job.data.runId
        });
        if (!statusClaimed) {
          await fs.rm(inventoryPath, { force: true });
          console.log(`Skipping stale Ansible job ${job.id} for deployment ${deploymentLabel} (customize)`);
          return { status: 'stale-job-skipped', extraVars };
        }

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

            const reconnectReporter = createCustomizationReconnectReporter(
              job,
              windowsTimezoneTargets.map(target => target.vmid)
            );
            await waitForWindowsReconnect({
              targets: windowsTimezoneTargets,
              password: extraVars.windows_admin_password,
              signal: abortController.signal,
              onHostReady: target => reconnectReporter.markReconnected(target.vmid)
            });

            const hasDomainTargets = windowsTimezoneTargets.some(t => t.domainRole);
            if (hasDomainTargets) {
              await runCommand(
                'ansible-playbook',
                [windowsDomainPlaybookPath, ...commonArgs],
                {
                  cwd: ansibleDir,
                  env: { ...process.env },
                  signal: abortController.signal
                }
              );
            }
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

  worker.on('stalled', async (jobId) => {
    try {
      const stalledJob = await ansibleQueue.getJob(jobId);
      const deploymentId = stalledJob?.data?.deploymentId;
      if (deploymentId) {
        await safeUpdateDeploymentStatus(deploymentId, 'failed', {
          action: 'customize',
          jobId: String(jobId),
          runId: stalledJob?.data?.runId
        });
        console.warn(`[stalled] Ansible job ${jobId} → deployment ${deploymentId} marqué failed`);
      }
    } catch (err) {
      console.error(`[stalled] Impossible de traiter le job stalled ${jobId}:`, err);
    }
  });

  worker.cancelActiveJobs = async () => {
    for (const controller of activeAbortControllers.values()) {
      controller.abort(new Error('Job cancelled from dashboard clear history action'));
    }
  };

  return worker;
}

export async function resetStalledAnsibleDeployments() {
  try {
    const result = await dbPool.query(
      `UPDATE lab_deployments
         SET status = 'failed', last_action = 'worker-restarted', updated_at = NOW()
       WHERE status = 'customizing'`
    );
    if (result.rowCount > 0) {
      console.log(`[startup] ${result.rowCount} déploiement(s) bloqué(s) en customizing remis à failed`);
    }
  } catch (err) {
    console.error('[startup] Impossible de réinitialiser les déploiements bloqués:', err);
  }
}
