import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { Worker } from 'bullmq';
import { Pool } from 'pg';
import { runCommand } from '../lib/runCommand.js';
import { readFile, writeFile } from 'node:fs/promises';
import {
  assertRequiredTerraformEnvSettings,
  defaultTerraformSettings,
  readTerraformEnvSettings,
  sanitizeSettingsInput
} from '../lib/terraformSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const terraformDir = path.resolve(__dirname, '../terraform');
const terraformVarsPath = path.resolve(__dirname, '../config/terraform-settings.json');
const sanitizedVarsPath = path.resolve(terraformDir, '.terraform-vars.json');
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory'
});

const requestJson = ({ url, method = 'GET', headers = {}, rejectUnauthorized = true }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      target,
      {
        method,
        headers,
        rejectUnauthorized
      },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('error', reject);
    request.end();
  });

const proxmoxRequestOptions = envSettings => ({
  headers: {
    Authorization: `PVEAPIToken=${envSettings.proxmox_api_token_id}=${envSettings.proxmox_api_token_secret}`
  },
  rejectUnauthorized: !envSettings.proxmox_tls_insecure
});

const resolveTemplateNamesByVmid = async (envSettings, blueprintVms) => {
  const apiUrl = new URL(
    'cluster/resources?type=vm',
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  const resources = Array.isArray(payload?.data) ? payload.data : [];

  return blueprintVms.map(vm => {
    const match = resources.find(resource => Number(resource.vmid) === Number(vm.cloneSource));
    if (!match?.name) {
      throw new Error(`Unable to resolve Proxmox template VMID ${vm.cloneSource} to a template name`);
    }
    return {
      ...vm,
      cloneSource: match.name
    };
  });
};

const updateLifecycleStatus = async (blueprintId, status, details = {}) => {
  if (!blueprintId) return;
  await dbPool.query(
    `UPDATE lab_deployments
     SET
       status = $2,
       last_action = $3,
       last_job_id = $4,
       last_run_id = $5,
       updated_at = NOW()
     WHERE id = $1`,
    [blueprintId, status, details.action ?? 'deploy', details.jobId ?? null, details.runId ?? null]
  );
};

const invokeVmPowerAction = async (envSettings, vmid, action) => {
  const actionUrl = new URL(
    `nodes/${envSettings.proxmox_node}/qemu/${vmid}/status/${action}`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  await requestJson({
    url: actionUrl,
    method: 'POST',
    ...proxmoxRequestOptions(envSettings)
  });
};

const safeUpdateLifecycleStatus = async (blueprintId, status, details = {}) => {
  try {
    await updateLifecycleStatus(blueprintId, status, details);
  } catch (error) {
    console.error(`Unable to update lifecycle status to ${status} for ${blueprintId}`, error);
  }
};

const workspaceNameFor = blueprintId => `blueprint-${String(blueprintId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

export const terraformQueueName = 'terraform-workflows';

export function startTerraformWorker(connection) {
  return new Worker(
    terraformQueueName,
    async job => {
      const env = {
        ...process.env,
        TF_IN_AUTOMATION: '1',
        TF_DATA_DIR: path.join(terraformDir, '.terraform')
      };
      const action =
        job.data.action === 'destroy'
          ? 'destroy'
          : job.data.action === 'start'
            ? 'start'
            : job.data.action === 'stop'
              ? 'stop'
              : 'deploy';
      const workspaceName = job.data.labInstanceId ? workspaceNameFor(job.data.labInstanceId) : 'default';
      try {
        console.log(`Terraform job ${job.id} started for ${job.data.labInstanceId} (${action})`);
        const inProgressStatus =
          action === 'destroy'
            ? 'destroying'
            : action === 'start'
              ? 'starting'
              : action === 'stop'
                ? 'stopping'
                : 'deploying';
        await safeUpdateLifecycleStatus(job.data.labInstanceId, inProgressStatus, {
          action,
          jobId: String(job.id),
          runId: job.data.runId
        });

        let preparedVarFile;
        try {
          const raw = await readFile(terraformVarsPath, 'utf8');
          const rawSettings = JSON.parse(raw);
          const sanitized = sanitizeSettingsInput(rawSettings);
          const envSettings = readTerraformEnvSettings();
          const merged = { ...defaultTerraformSettings, ...sanitized, ...envSettings };
          if (Array.isArray(job.data?.blueprint?.vms) && job.data.blueprint.vms.length > 0) {
            const resolvedBlueprintVms = await resolveTemplateNamesByVmid(
              envSettings,
              job.data.blueprint.vms
            );
            merged.vm_definitions = resolvedBlueprintVms.map(vm => ({
              vmid: Number(vm.vmid),
              name: vm.name,
              clone_source: String(vm.cloneSource),
              full_clone: Boolean(vm.fullClone),
              vlan_tag: Number(vm.vlanTag ?? merged.network_vlan_tag ?? 0)
            }));
          }
          assertRequiredTerraformEnvSettings(merged);
          await writeFile(sanitizedVarsPath, JSON.stringify(merged, null, 2));
          preparedVarFile = sanitizedVarsPath;

          if (action === 'start' || action === 'stop') {
            const desiredAction = action === 'start' ? 'start' : 'stop';
            const blueprintVms = Array.isArray(job.data?.blueprint?.vms) ? job.data.blueprint.vms : [];
            for (const vm of blueprintVms) {
              await invokeVmPowerAction(envSettings, vm.vmid, desiredAction);
            }

            await safeUpdateLifecycleStatus(
              job.data.labInstanceId,
              action === 'start' ? 'running' : 'stopped',
              {
                action,
                jobId: String(job.id),
                runId: job.data.runId
              }
            );

            console.log(`Terraform job ${job.id} finished for ${job.data.labInstanceId} (${action})`);
            return {
              planOutput: '',
              labInstanceId: job.data.labInstanceId,
              runId: job.data.runId
            };
          }
        } catch (err) {
          throw new Error(
            `Unable to prepare terraform vars (looked at ${terraformVarsPath}): ${err.message}`
          );
        }

        await runCommand('terraform', ['init', '-input=false'], { cwd: terraformDir, env });
        try {
          await runCommand('terraform', ['workspace', 'select', workspaceName], { cwd: terraformDir, env });
        } catch {
          await runCommand('terraform', ['workspace', 'new', workspaceName], { cwd: terraformDir, env });
        }

        let planOutput = '';
        if (action === 'destroy') {
          planOutput = await runCommand(
            'terraform',
            ['destroy', '-auto-approve', '-input=false', `-var-file=${preparedVarFile}`],
            { cwd: terraformDir, env }
          );
        } else {
          planOutput = await runCommand(
            'terraform',
            ['plan', '-out=tfplan', '-input=false', `-var-file=${preparedVarFile}`],
            { cwd: terraformDir, env }
          );
          await runCommand(
            'terraform',
            ['apply', '-auto-approve', 'tfplan'],
            { cwd: terraformDir, env }
          );
        }

        await safeUpdateLifecycleStatus(job.data.labInstanceId, action === 'destroy' ? 'destroyed' : 'deployed', {
          action,
          jobId: String(job.id),
          runId: job.data.runId
        });

        console.log(`Terraform job ${job.id} finished for ${job.data.labInstanceId} (${action})`);

        return {
          planOutput,
          labInstanceId: job.data.labInstanceId,
          runId: job.data.runId
        };
      } catch (error) {
        console.error(`Terraform job ${job.id} failed for ${job.data.labInstanceId} (${action})`, error);
        await safeUpdateLifecycleStatus(job.data.labInstanceId, 'failed', {
          action,
          jobId: String(job.id),
          runId: job.data.runId
        });
        throw error;
      }
    },
    { connection, concurrency: 1 }
  );
}
