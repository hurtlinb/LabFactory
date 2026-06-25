import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setMaxListeners } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import { runCommand } from '../lib/runCommand.js';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ansibleQueueName } from './ansibleWorker.js';
import {
  assertRequiredTerraformEnvSettings,
  defaultTerraformSettings,
  readTerraformEnvSettings,
  sanitizeSettingsInput
} from '../lib/terraformSettings.js';

const LINUX_SSH_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const LINUX_SSH_ATTEMPT_TIMEOUT_SECONDS = 45;
const WINDOWS_WINRM_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
// A round now checks every still-pending Windows VM in one ansible-playbook run (not just one
// host), so this has to cover the slowest host in the batch (e.g. unreachable ones still timing
// out their WinRM connection attempt) before Ansible can move on to the next task for anyone.
const WINDOWS_WINRM_ATTEMPT_TIMEOUT_SECONDS = 180;
const WINDOWS_WINRM_STABLE_RECHECK_MS = 30000;

// Guest readiness (cloudbase-init / cloud-init) typically takes minutes, not seconds — poll fast
// at first, then back off so we don't spawn an ansible-playbook process every 5s for the long tail.
const READINESS_RETRY_BACKOFF_STEPS = [
  { afterMs: 0, delayMs: 5000 },
  { afterMs: 60 * 1000, delayMs: 15000 },
  { afterMs: 5 * 60 * 1000, delayMs: 30000 }
];

const computeReadinessRetryDelayMs = elapsedMs => {
  let delayMs = READINESS_RETRY_BACKOFF_STEPS[0].delayMs;
  for (const step of READINESS_RETRY_BACKOFF_STEPS) {
    if (elapsedMs >= step.afterMs) {
      delayMs = step.delayMs;
    }
  }
  return delayMs;
};
const VM_POWER_STATE_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const VM_POWER_STATE_WAIT_RETRY_MS = 5000;
const STOP_STATE_CONFIRMATION_TIMEOUT_MS = 60 * 1000;
const STOP_STATE_RECHECK_DELAY_MS = 30 * 1000;
const STOP_STATE_MAX_RETRIES = 40;
const PROXMOX_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const PROXMOX_TASK_WAIT_RETRY_MS = 2000;
const DEFAULT_TERRAFORM_PARALLELISM = 10;
const MAX_TERRAFORM_PARALLELISM = 64;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const terraformDir = path.resolve(__dirname, '../terraform');
const terraformVarsPath = path.resolve(__dirname, '../config/terraform-settings.json');
const sanitizedVarsPath = path.resolve(terraformDir, '.terraform-vars.json');
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory'
});

const buildHttpError = (statusCode, body) => {
  let proxmoxMessage = null;
  try {
    proxmoxMessage = JSON.parse(body)?.message ?? null;
  } catch {
    proxmoxMessage = null;
  }

  const detail = String(proxmoxMessage ?? body ?? '').trim();
  const error = new Error(`HTTP ${statusCode}${detail ? `: ${detail}` : ''}`);
  error.statusCode = statusCode;
  error.body = body;
  error.proxmoxMessage = proxmoxMessage;
  return error;
};

const formatProxmoxError = error =>
  String(error?.proxmoxMessage ?? error?.message ?? error)
    .replace(/\s+/g, ' ')
    .trim();

const isProxmoxVmMissingMessage = message =>
  /does not exist|no such file or directory|not found|non[ -]?existent/i.test(String(message ?? '').trim());

const encodeRequestBody = body => {
  if (body === null || body === undefined) {
    return null;
  }
  if (body instanceof URLSearchParams) {
    return {
      content: body.toString(),
      contentType: 'application/x-www-form-urlencoded'
    };
  }
  if (typeof body === 'string') {
    return { content: body, contentType: null };
  }
  return {
    content: new URLSearchParams(
      Object.entries(body)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, String(value)])
    ).toString(),
    contentType: 'application/x-www-form-urlencoded'
  };
};

const requestJson = ({ url, method = 'GET', headers = {}, rejectUnauthorized = true, body = null }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const requestBody = encodeRequestBody(body);
    const requestHeaders = { ...headers };
    if (requestBody?.contentType && !Object.keys(requestHeaders).some(header => header.toLowerCase() === 'content-type')) {
      requestHeaders['Content-Type'] = requestBody.contentType;
    }
    if (requestBody && !Object.keys(requestHeaders).some(header => header.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = Buffer.byteLength(requestBody.content);
    }
    const request = transport.request(
      target,
      {
        method,
        headers: requestHeaders,
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
            reject(buildHttpError(response.statusCode, body));
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
    if (requestBody) {
      request.write(requestBody.content);
    }
    request.end();
  });

const proxmoxRequestOptions = envSettings => ({
  headers: {
    Authorization: `PVEAPIToken=${envSettings.proxmox_api_token_id}=${envSettings.proxmox_api_token_secret}`
  },
  rejectUnauthorized: !envSettings.proxmox_tls_insecure
});

const isProxmoxTemplate = value => value === true || value === 1 || String(value).trim() === '1';

const resolveTerraformParallelism = () => {
  const rawValue = String(process.env.TERRAFORM_PARALLELISM ?? '').trim();
  if (!rawValue) {
    return DEFAULT_TERRAFORM_PARALLELISM;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('TERRAFORM_PARALLELISM must be a positive integer');
  }

  return Math.min(parsed, MAX_TERRAFORM_PARALLELISM);
};

const runWithConcurrency = async (items, concurrency, handler) => {
  const queue = [...items];
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), queue.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const item = queue.shift();
        await handler(item);
      }
    })
  );
};

const mergeVmTags = (...tagValues) => {
  const tags = [];
  for (const value of tagValues) {
    for (const rawTag of String(value ?? '').split(/[;,]/)) {
      const tag = rawTag.trim();
      if (tag && !tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }
  return tags.length ? tags.join(';') : null;
};

const normalizeVmids = value =>
  [...new Set(
    (Array.isArray(value) ? value : [])
      .map(vmid => Number(vmid))
      .filter(vmid => Number.isInteger(vmid))
  )].sort((left, right) => left - right);

const buildTerraformReplaceArgs = vmids =>
  normalizeVmids(vmids).map(vmid => `-replace=proxmox_vm_qemu.lab_vm["${vmid}"]`);

const buildTerraformTargetArgs = vmids =>
  normalizeVmids(vmids).map(vmid => `-target=proxmox_vm_qemu.lab_vm["${vmid}"]`);

const fetchVmConfig = async (envSettings, node, vmid) => {
  const apiUrl = new URL(
    `nodes/${node}/qemu/${vmid}/config`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? {};
};

const fetchProxmoxNodeNames = async (envSettings, { onlineOnly = false } = {}) => {
  const apiUrl = new URL(
    'nodes',
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter(node => {
      const status = String(node?.status ?? '').trim().toLowerCase();
      return !onlineOnly || !status || status === 'online';
    })
    .map(node => String(node?.node ?? '').trim())
    .filter(Boolean);
};

const normalizeProxmoxNodeList = value => {
  const rawNodes = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(rawNodes.map(node => String(node).trim()).filter(Boolean))];
};

const resolveProxmoxTargetNodes = async envSettings => {
  const configuredNodes = normalizeProxmoxNodeList(envSettings.proxmox_nodes);
  if (configuredNodes.length) {
    return configuredNodes;
  }

  let discoveredNodes = [];
  try {
    discoveredNodes = await fetchProxmoxNodeNames(envSettings, { onlineOnly: true });
  } catch (error) {
    console.warn(
      `Unable to discover Proxmox nodes for VM distribution; falling back to PROXMOX_NODE (${formatProxmoxError(error)})`
    );
  }
  if (discoveredNodes.length) {
    const preferredNode = String(envSettings.proxmox_node ?? '').trim();
    return [
      ...new Set([
        ...(discoveredNodes.includes(preferredNode) ? [preferredNode] : []),
        ...discoveredNodes
      ])
    ];
  }

  return normalizeProxmoxNodeList(envSettings.proxmox_node);
};

const fetchProxmoxVmResources = async envSettings => {
  const apiUrl = new URL(
    'cluster/resources?type=vm',
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return Array.isArray(payload?.data) ? payload.data : [];
};

const fetchVmCurrentStatus = async (envSettings, node, vmid) => {
  const apiUrl = new URL(
    `nodes/${node}/qemu/${vmid}/status/current`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? {};
};

const fetchStorageContent = async (envSettings, node, storage) => {
  const apiUrl = new URL(
    `nodes/${node}/storage/${encodeURIComponent(storage)}/content`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return Array.isArray(payload?.data) ? payload.data : [];
};

const fetchProxmoxTaskStatus = async (envSettings, node, upid) => {
  const apiUrl = new URL(
    `nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'GET',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? {};
};

const waitForProxmoxTask = async (envSettings, node, upid, { timeoutMs = PROXMOX_TASK_WAIT_TIMEOUT_MS } = {}) => {
  const normalizedUpid = String(upid ?? '').trim();
  if (!normalizedUpid) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await fetchProxmoxTaskStatus(envSettings, node, normalizedUpid);
    const state = String(status?.status ?? '').trim().toLowerCase();
    if (state === 'stopped') {
      const exitStatus = String(status?.exitstatus ?? '').trim();
      if (!exitStatus || exitStatus.toUpperCase() === 'OK') {
        return;
      }
      throw new Error(`Proxmox task ${normalizedUpid} failed with exit status ${exitStatus}`);
    }
    await sleep(PROXMOX_TASK_WAIT_RETRY_MS);
  }

  throw new Error(`Timed out waiting for Proxmox task ${normalizedUpid} on node ${node}`);
};

const deleteStorageVolume = async (envSettings, node, storage, volid) => {
  const apiUrl = new URL(
    `nodes/${node}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  const payload = await requestJson({
    url: apiUrl,
    method: 'DELETE',
    ...proxmoxRequestOptions(envSettings)
  });
  return payload?.data ?? null;
};

const resolveVmByDirectConfigLookup = async (envSettings, vmid) => {
  const failures = [];
  let discoveredNodes = [];
  try {
    discoveredNodes = await fetchProxmoxNodeNames(envSettings);
  } catch (error) {
    failures.push({ node: 'nodes', message: formatProxmoxError(error) });
  }
  const nodes = [
    String(envSettings.proxmox_node ?? '').trim(),
    ...discoveredNodes
  ].filter(Boolean);
  const uniqueNodes = [...new Set(nodes)];

  for (const node of uniqueNodes) {
    try {
      const config = await fetchVmConfig(envSettings, node, vmid);
      const name = String(config?.name ?? '').trim();
      if (!name) {
        failures.push({ node, message: 'VM config was found but did not include a name' });
        continue;
      }
      return {
        match: {
          vmid: Number(vmid),
          name,
          node,
          template: isProxmoxTemplate(config?.template)
        },
        failures
      };
    } catch (error) {
      failures.push({ node, message: formatProxmoxError(error) });
    }
  }

  return { match: null, failures };
};

const formatTemplateLookupFailure = ({ vmid, resources, failures }) => {
  const details = [
    `Unable to resolve Proxmox template VMID ${vmid} to a template name.`
  ];
  if (resources.length === 0) {
    details.push(
      'The Proxmox API returned 0 VM resources from cluster/resources?type=vm; the API token may lack VM.Audit on the template VM or VM inventory.'
    );
  }
  if (failures.length) {
    const directLookupErrors = failures
      .map(failure => `${failure.node}: ${failure.message}`)
      .join('; ');
    details.push(`Direct VMID lookup also failed (${directLookupErrors}).`);
  }
  return details.join(' ');
};

const extractTemplateDiskConfig = config => {
  const diskKey = ['scsi', 'virtio', 'sata', 'ide']
    .flatMap(prefix => Array.from({ length: 10 }, (_, index) => `${prefix}${index}`))
    .find(key => {
      const value = String(config?.[key] ?? '');
      return value && !value.includes('media=cdrom') && !value.includes('cloudinit');
    });

  if (!diskKey) {
    throw new Error('Unable to find a bootable template disk in Proxmox VM config');
  }

  const diskValue = String(config[diskKey] ?? '');
  const diskStorage = diskValue.split(':')[0];
  const diskSize = diskValue.match(/size=([^,]+)/)?.[1] ?? null;

  return {
    diskType: 'disk',
    diskSlot: diskKey,
    diskStorage,
    diskSize
  };
};

const extractTemplateCloudInitConfig = config => {
  const cloudInitKey = ['scsi', 'virtio', 'sata', 'ide']
    .flatMap(prefix => Array.from({ length: 10 }, (_, index) => `${prefix}${index}`))
    .find(key => String(config?.[key] ?? '').includes('cloudinit'));

  if (!cloudInitKey) {
    return {
      cloudinitSlot: null,
      cloudinitStorage: null
    };
  }

  return {
    cloudinitSlot: cloudInitKey,
    cloudinitStorage: String(config[cloudInitKey] ?? '').split(':')[0] || null
  };
};

const computeSecondDiskSlot = (primarySlot, cloudinitSlot) => {
  const match = String(primarySlot ?? '').match(/^([a-z]+)(\d+)$/);
  if (!match) return null;
  const [, prefix, indexStr] = match;
  let nextIndex = Number(indexStr) + 1;
  let candidate = `${prefix}${nextIndex}`;
  while (candidate === cloudinitSlot) {
    nextIndex += 1;
    candidate = `${prefix}${nextIndex}`;
  }
  return candidate;
};

const extractTemplateFirmwareConfig = config => ({
  bios: String(config?.bios ?? '').trim() || null,
  machine: String(config?.machine ?? '').trim() || null
});

const resolveTemplateNamesByVmid = async (envSettings, blueprintVms) => {
  const resources = await fetchProxmoxVmResources(envSettings);
  const matches = [];
  for (const vm of blueprintVms) {
    const match = resources.find(resource => Number(resource.vmid) === Number(vm.cloneSource));
    if (!match?.name) {
      const { match: directMatch, failures } = await resolveVmByDirectConfigLookup(
        envSettings,
        vm.cloneSource
      );
      if (!directMatch?.name) {
        throw new Error(formatTemplateLookupFailure({
          vmid: vm.cloneSource,
          resources,
          failures
        }));
      }
      if (!directMatch.template) {
        throw new Error(`Proxmox VMID ${vm.cloneSource} is not marked as a template`);
      }
      matches.push(directMatch);
      continue;
    }
    if (!isProxmoxTemplate(match.template)) {
      throw new Error(`Proxmox VMID ${vm.cloneSource} is not marked as a template`);
    }
    matches.push(match);
  }
  const vmidsByTemplateName = matches.reduce((acc, match) => {
    if (!acc.has(match.name)) {
      acc.set(match.name, new Set());
    }
    acc.get(match.name).add(Number(match.vmid));
    return acc;
  }, new Map());
  const ambiguousTemplate = Array.from(vmidsByTemplateName.entries()).find(([, vmids]) => vmids.size > 1);

  if (ambiguousTemplate) {
    const [templateName, vmids] = ambiguousTemplate;
    throw new Error(
      `Ambiguous Proxmox template name "${templateName}" for VMIDs ${Array.from(vmids).join(', ')}. Rename the source templates in Proxmox so each template has a unique name.`
    );
  }

  return matches.reduce(async (promise, match, index) => {
    const acc = await promise;
    const vm = blueprintVms[index];
    const config = await fetchVmConfig(envSettings, match.node, vm.cloneSource);
    const diskConfig = extractTemplateDiskConfig(config);
    const cloudInitConfig = extractTemplateCloudInitConfig(config);
    const firmwareConfig = extractTemplateFirmwareConfig(config);
    return [
      ...acc,
      {
        ...vm,
        cloneSource: match.name,
        diskType: diskConfig.diskType,
        diskSlot: diskConfig.diskSlot,
        diskStorage: diskConfig.diskStorage,
        diskSize: diskConfig.diskSize,
        secondDiskSlot: vm.secondDiskSizeGb
          ? computeSecondDiskSlot(diskConfig.diskSlot, cloudInitConfig.cloudinitSlot)
          : null,
        cloudinitSlot: cloudInitConfig.cloudinitSlot,
        cloudinitStorage: cloudInitConfig.cloudinitStorage,
        bios: firmwareConfig.bios,
        machine: firmwareConfig.machine
      }
    ];
  }, Promise.resolve([]));
};

const updateLifecycleStatus = async (blueprintId, status, details = {}) => {
  if (!blueprintId) return false;
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
    [blueprintId, status, details.action ?? 'deploy', details.jobId ?? null, details.runId ?? null, expectedRunId]
  );
  return result.rowCount > 0;
};

const fetchDeploymentLifecycleState = async deploymentId => {
  if (!deploymentId) return null;
  const result = await dbPool.query(
    `SELECT id, status, last_job_id, last_run_id
       FROM lab_deployments
      WHERE id = $1`,
    [deploymentId]
  );
  if (!result.rowCount) return null;
  return {
    id: result.rows[0].id,
    status: result.rows[0].status,
    lastJobId: result.rows[0].last_job_id ?? null,
    lastRunId: result.rows[0].last_run_id ?? null
  };
};

const resolveVmNodesByVmid = async (envSettings, vmids, { allowMissing = false } = {}) => {
  const requestedVmids = [
    ...new Set(vmids.map(vmid => Number(vmid)).filter(vmid => Number.isInteger(vmid) && vmid > 0))
  ];
  const nodeByVmid = new Map();
  let resourceLookupError = null;
  let resources = [];

  try {
    resources = await fetchProxmoxVmResources(envSettings);
  } catch (error) {
    resourceLookupError = formatProxmoxError(error);
  }

  for (const vmid of requestedVmids) {
    const match = resources.find(resource => Number(resource.vmid) === vmid);
    const node = String(match?.node ?? '').trim();
    if (node) {
      nodeByVmid.set(vmid, node);
    }
  }

  for (const vmid of requestedVmids.filter(vmid => !nodeByVmid.has(vmid))) {
    const { match, failures } = await resolveVmByDirectConfigLookup(envSettings, vmid);
    if (match?.node) {
      nodeByVmid.set(vmid, match.node);
      continue;
    }

    const missingEverywhere =
      failures.length > 0 &&
      failures.every(failure => isProxmoxVmMissingMessage(failure.message));
    if (allowMissing && missingEverywhere) {
      console.warn(`Skipping power action for missing VMID ${vmid}: VM not found on any Proxmox node`);
      continue;
    }

    const details = [
      resourceLookupError ? `cluster resource lookup failed: ${resourceLookupError}` : null,
      failures.length ? `direct lookup failed: ${failures.map(failure => `${failure.node}: ${failure.message}`).join('; ')}` : null
    ].filter(Boolean);
    throw new Error(
      `Unable to resolve Proxmox node for VMID ${vmid}${details.length ? ` (${details.join('; ')})` : ''}`
    );
  }

  return nodeByVmid;
};

const waitForVmPowerState = async ({ envSettings, vmids, desiredState, signal, timeoutMs = VM_POWER_STATE_WAIT_TIMEOUT_MS, returnOnTimeout = false }) => {
  const targetVmids = [...new Set(
    (Array.isArray(vmids) ? vmids : [])
      .map(vmid => Number(vmid))
      .filter(vmid => Number.isInteger(vmid) && vmid > 0)
  )];
  if (!targetVmids.length) {
    return true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('VM power state wait aborted');
    }

    let resources = [];
    try {
      resources = await fetchProxmoxVmResources(envSettings);
    } catch {
      resources = [];
    }

    let allMatch = true;
    if (desiredState === 'stopped') {
      const resourceByVmid = new Map(
        resources.map(resource => [Number(resource.vmid), resource])
      );
      const candidateVmids = targetVmids.filter(vmid => {
        const state = String(resourceByVmid.get(vmid)?.status ?? '').trim().toLowerCase();
        return state && state !== 'stopped';
      });
      const nodeByVmid = await resolveVmNodesByVmid(envSettings, candidateVmids, { allowMissing: true });

      const currentStates = await Promise.all(
        candidateVmids.map(async vmid => {
          const node = nodeByVmid.get(vmid);
          if (!node) {
            const resourceState = String(resourceByVmid.get(vmid)?.status ?? '').trim().toLowerCase();
            if (resourceState && resourceState !== 'stopped') {
              console.log(`Ignoring stale Proxmox resource state for missing VMID ${vmid}: ${resourceState}`);
            }
            return { vmid, state: 'missing' };
          }
          try {
            const current = await fetchVmCurrentStatus(envSettings, node, vmid);
            return {
              vmid,
              state: String(current?.status ?? current?.qmpstatus ?? '').trim().toLowerCase() || 'unknown'
            };
          } catch (error) {
            const message = formatProxmoxError(error);
            if (isProxmoxVmMissingMessage(message)) {
              return { vmid, state: 'missing' };
            }
            return { vmid, state: `error:${message}` };
          }
        })
      );

      const blockingStates = currentStates.filter(entry =>
        !['stopped', 'missing'].includes(entry.state)
      );
      allMatch = blockingStates.length === 0;
      if (!allMatch) {
        console.log(
          `Still waiting for VM stop states: ${blockingStates.map(entry => `${entry.vmid}=${entry.state}`).join(', ')}`
        );
      }
    } else {
      allMatch = targetVmids.every(vmid => {
        const state = resources.find(resource => Number(resource.vmid) === vmid)?.status ?? null;
        return state === desiredState;
      });
    }

    if (allMatch) {
      return true;
    }

    await sleep(VM_POWER_STATE_WAIT_RETRY_MS);
  }

  if (returnOnTimeout) {
    return false;
  }

  throw new Error(`Timed out waiting for VM power state "${desiredState}" for VMIDs ${targetVmids.join(', ')}`);
};

const getStorageVolumeName = volid => {
  const withoutStorage = String(volid ?? '').split(':').slice(1).join(':');
  return withoutStorage.split('/').filter(Boolean).pop() ?? '';
};

const isVmAbsentFromProxmox = async (envSettings, vmid, resources = null) => {
  const numericVmid = Number(vmid);
  if (!Number.isInteger(numericVmid) || numericVmid <= 0) {
    return false;
  }

  if (Array.isArray(resources) && resources.some(resource => Number(resource.vmid) === numericVmid)) {
    return false;
  }

  const { match, failures } = await resolveVmByDirectConfigLookup(envSettings, numericVmid);
  if (match) {
    return false;
  }

  if (!Array.isArray(resources) && failures.length > 0) {
    return null;
  }

  return true;
};

const buildDestroyedVmVolumeCleanupCandidates = ({ envSettings, vmDefinitions }) => {
  const targetNodes = normalizeProxmoxNodeList(envSettings.proxmox_nodes).length
    ? normalizeProxmoxNodeList(envSettings.proxmox_nodes)
    : normalizeProxmoxNodeList(envSettings.proxmox_node);
  if (!targetNodes.length) {
    return [];
  }

  return (Array.isArray(vmDefinitions) ? vmDefinitions : [])
    .flatMap((vm, index) => {
      const storages = [
        String(vm.disk_storage ?? '').trim(),
        String(vm.cloudinit_storage ?? '').trim()
      ].filter(Boolean);
      const uniqueStorages = [...new Set(storages)];
      const node = targetNodes[index % targetNodes.length];
      return uniqueStorages.map(storage => ({
        vmid: Number(vm.vmid),
        node,
        storage
      }));
    })
    .filter(candidate =>
      Number.isInteger(candidate.vmid) &&
      candidate.vmid > 0 &&
      candidate.node &&
      candidate.storage
    );
};

const cleanupDestroyedVmVolumes = async (envSettings, vmDefinitions) => {
  const candidates = buildDestroyedVmVolumeCleanupCandidates({ envSettings, vmDefinitions });
  if (!candidates.length) {
    return;
  }

  const resources = await fetchProxmoxVmResources(envSettings).catch(error => {
    console.warn(`Unable to fetch Proxmox VM resources before post-destroy cleanup (${formatProxmoxError(error)})`);
    return null;
  });

  await runWithConcurrency(candidates, Math.min(resolveTerraformParallelism(), 8), async candidate => {
    const isAbsent = await isVmAbsentFromProxmox(envSettings, candidate.vmid, resources);
    if (isAbsent !== true) {
      if (isAbsent === null) {
        console.warn(`Skipping post-destroy volume cleanup for VMID ${candidate.vmid}: unable to prove that the VM is absent`);
      }
      return;
    }

    let content;
    try {
      content = await fetchStorageContent(envSettings, candidate.node, candidate.storage);
    } catch (error) {
      console.warn(
        `Unable to inspect storage ${candidate.storage} on ${candidate.node} for post-destroy cleanup of VMID ${candidate.vmid} (${formatProxmoxError(error)})`
      );
      return;
    }

    const volumePrefix = `vm-${candidate.vmid}-`;
    const volidsToDelete = content
      .map(volume => String(volume?.volid ?? '').trim())
      .filter(volid =>
        volid.startsWith(`${candidate.storage}:`) &&
        getStorageVolumeName(volid).startsWith(volumePrefix)
      );

    for (const volid of [...new Set(volidsToDelete)]) {
      console.log(`Deleting orphaned volume ${volid} after destroy for VMID ${candidate.vmid} on ${candidate.node}/${candidate.storage}`);
      try {
        const taskId = await deleteStorageVolume(envSettings, candidate.node, candidate.storage, volid);
        await waitForProxmoxTask(envSettings, candidate.node, taskId);
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 500 && /does not exist|no such|not found|unable to parse/i.test(formatProxmoxError(error))) {
          continue;
        }
        throw error;
      }
    }
  });
};

const invokeVmPowerAction = async (envSettings, node, vmid, action) => {
  const actionUrl = new URL(
    `nodes/${node}/qemu/${vmid}/status/${action}`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  await requestJson({
    url: actionUrl,
    method: 'POST',
    ...proxmoxRequestOptions(envSettings)
  });
};

const isProxmoxHaResourceMissing = error =>
  error?.statusCode === 404 || /no such resource|does not exist|not found/i.test(formatProxmoxError(error));

const isProxmoxHaResourceAlreadyExists = error =>
  /already exists|resource.*exists|duplicate/i.test(formatProxmoxError(error));

const normalizeVmHaState = value => {
  const state = String(value ?? '').trim().toLowerCase();
  return ['started', 'stopped', 'enabled', 'disabled', 'ignored'].includes(state) ? state : '';
};

const setVmHaState = async (envSettings, vmid, state) => {
  const sid = `vm:${Number(vmid)}`;
  const apiUrl = new URL(
    `cluster/ha/resources/${encodeURIComponent(sid)}`,
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  await requestJson({
    url: apiUrl,
    method: 'PUT',
    body: { state },
    ...proxmoxRequestOptions(envSettings)
  });
};

const createVmHaResource = async (envSettings, vmid, state) => {
  const sid = `vm:${Number(vmid)}`;
  const apiUrl = new URL(
    'cluster/ha/resources',
    `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`
  );
  await requestJson({
    url: apiUrl,
    method: 'POST',
    body: { sid, state },
    ...proxmoxRequestOptions(envSettings)
  });
};

const ensureVmHaState = async (envSettings, vmid, state) => {
  const normalizedState = normalizeVmHaState(state);
  if (!normalizedState) {
    return false;
  }

  try {
    await setVmHaState(envSettings, vmid, normalizedState);
  } catch (error) {
    if (!isProxmoxHaResourceMissing(error)) {
      throw error;
    }

    try {
      await createVmHaResource(envSettings, vmid, normalizedState);
    } catch (createError) {
      if (!isProxmoxHaResourceAlreadyExists(createError)) {
        throw createError;
      }
      await setVmHaState(envSettings, vmid, normalizedState);
    }
  }

  return true;
};

const requestVmPowerState = async (envSettings, node, vmid, action) => {
  const haState = action === 'start' ? 'started' : action === 'shutdown' ? 'stopped' : null;
  if (haState) {
    try {
      await setVmHaState(envSettings, vmid, haState);
      console.log(`Requested Proxmox HA state "${haState}" for VMID ${vmid}`);
      return;
    } catch (error) {
      if (!isProxmoxHaResourceMissing(error)) {
        throw error;
      }
    }
  }

  await invokeVmPowerAction(envSettings, node, vmid, action);
};

const safeUpdateLifecycleStatus = async (blueprintId, status, details = {}) => {
  try {
    const updated = await updateLifecycleStatus(blueprintId, status, details);
    if (!updated && blueprintId) {
      console.warn(
        `Skipping stale lifecycle status update to ${status} for ${blueprintId} (runId=${details.runId ?? 'n/a'})`
      );
    }
    return updated;
  } catch (error) {
    console.error(`Unable to update lifecycle status to ${status} for ${blueprintId}`, error);
    return false;
  }
};

const workspaceNameFor = blueprintId => `blueprint-${String(blueprintId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
const isWindowsOsType = osType => ['windows11', 'windows-server'].includes(String(osType ?? '').trim());
const isLinuxOsType = osType => !isWindowsOsType(osType);
const isLinuxCloudInitOsType = osType => ['ubuntu'].includes(String(osType ?? '').trim().toLowerCase());
const getWindowsAdminUsername = language =>
  (String(language ?? '').trim().toLowerCase() === 'fr' ? 'Administrateur' : 'Administrator');

const parseVlanMaskBits = mask => {
  const match = /^\/(\d{1,2})$/.exec(String(mask || '').trim());
  if (!match) {
    throw new Error(`Invalid VLAN mask "${mask}"`);
  }
  const bits = Number(match[1]);
  if (bits < 24 || bits > 30) {
    throw new Error(`Unsupported VLAN mask "${mask}". Expected /24 to /30.`);
  }
  return bits;
};

const parseSubnetBase = subnet => {
  const parts = String(subnet || '')
    .trim()
    .split('.')
    .map(part => Number(part));
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
    parts[3] !== 0
  ) {
    throw new Error(`Invalid classroom subnet "${subnet}". Expected a network like 10.0.200.0.`);
  }
  return parts;
};

const buildCloudInitIpConfig = ({ subnetBase, mask, ipLastOctet, gatewayIp }) => {
  if (ipLastOctet == null) {
    return 'ip=dhcp';
  }

  const maskBits = parseVlanMaskBits(mask);
  const subnetSize = 2 ** (32 - maskBits);
  const offsetInSubnet = Number(ipLastOctet) % subnetSize;
  if (offsetInSubnet === 0 || offsetInSubnet === subnetSize - 1) {
    throw new Error(`IP last octet ${ipLastOctet} is reserved for VLAN mask ${mask}`);
  }

  const gatewayParts = String(gatewayIp ?? '').trim().split('.').map(Number);
  const gatewayHostOctet = gatewayParts[3];
  if (gatewayParts.length !== 4 || gatewayParts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Gateway IP ${gatewayIp} is invalid`);
  }

  const subnetBaseOctet = Math.floor(Number(ipLastOctet) / subnetSize) * subnetSize;
  const gatewayOffsetInSubnet = gatewayHostOctet % subnetSize;
  if (gatewayOffsetInSubnet === 0 || gatewayOffsetInSubnet === subnetSize - 1) {
    throw new Error(`Gateway IP ${gatewayIp} is invalid for VLAN mask ${mask}`);
  }
  const gatewayOctet = subnetBaseOctet + gatewayOffsetInSubnet;
  if (gatewayOctet === Number(ipLastOctet)) {
    throw new Error(`IP last octet ${ipLastOctet} conflicts with gateway ${gatewayIp}`);
  }

  const [octet1, octet2, thirdOctet] = parseSubnetBase(subnetBase);
  const address = `${octet1}.${octet2}.${thirdOctet}.${Number(ipLastOctet)}`;
  const gateway = `${octet1}.${octet2}.${thirdOctet}.${gatewayOctet}`;
  return `ip=${address}${mask},gw=${gateway}`;
};

const buildStaticVmIpAddress = vm => {
  if (vm.ipLastOctet == null || !vm.subnetBase) {
    return null;
  }

  const subnetParts = String(vm.subnetBase).split('.').slice(0, 3);
  if (subnetParts.length !== 3 || subnetParts.some(part => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  return `${subnetParts.join('.')}.${Number(vm.ipLastOctet)}`;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const windowsCloudbaseReadinessPlaybook = `- name: Wait for Windows Cloudbase-Init
  hosts: windows_readiness_targets
  gather_facts: false
  tasks:
    - name: Check Cloudbase-Init completion for current boot
      ansible.windows.win_powershell:
        script: |
          $flag = 'C:\\ProgramData\\cloudbase-init\\done.flag'
          if (-not (Test-Path -LiteralPath $flag)) {
            Write-Error 'Cloudbase-Init has not finished'
            exit 1
          }

          $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
          $flagTime = (Get-Item -LiteralPath $flag).LastWriteTime
          if ($flagTime -lt $bootTime) {
            Write-Error "Cloudbase-Init done flag is stale: $flagTime is before boot $bootTime"
            exit 1
          }

          $cloudbaseServices = Get-Service -Name 'cloudbase-init','cloudbaseinit' -ErrorAction SilentlyContinue
          $activeServices = @($cloudbaseServices | Where-Object { $_.Status -in @('StartPending', 'Running', 'ContinuePending') })
          if ($activeServices.Count -gt 0) {
            Write-Error "Cloudbase-Init service is still active: $($activeServices.Name -join ', ')"
            exit 1
          }

          Write-Output "Cloudbase-Init completed at $flagTime and WinRM is reachable"
      ignore_errors: true
      register: cloudbase_init_check

    - name: Record per-host readiness marker
      ansible.builtin.copy:
        content: "ready"
        dest: "{{ marker_dir }}/{{ inventory_hostname }}"
        mode: '0644'
      delegate_to: localhost
      when: cloudbase_init_check is succeeded
`;

const buildWindowsReadinessInventory = (targets, password) => {
  const hosts = targets
    .map(target => [
      `        vm_${target.vmid}:`,
      `          ansible_host: ${JSON.stringify(target.host)}`,
      `          ansible_user: ${JSON.stringify(target.user)}`,
      `          ansible_password: ${JSON.stringify(password)}`,
      '          ansible_connection: winrm',
      '          ansible_port: 5986',
      '          ansible_winrm_scheme: https',
      '          ansible_winrm_transport: basic',
      '          ansible_winrm_server_cert_validation: ignore',
      '          ansible_winrm_operation_timeout_sec: 30',
      '          ansible_winrm_read_timeout_sec: 45'
    ].join('\n'))
    .join('\n');

  return `all:
  children:
    windows_readiness_targets:
      hosts:
${hosts}
`;
};

const waitForLinuxSshAndCloudInit = async ({ host, user, password, signal }) => {
  const startedAt = Date.now();
  let lastError = null;
  const remoteCommand = [
    "if ! command -v cloud-init >/dev/null 2>&1; then echo 'cloud-init command not found' >&2; exit 1; fi",
    "boot_finished=/var/lib/cloud/instance/boot-finished",
    "if test -f \"$boot_finished\"; then exit 0; fi",
    "status_text=$(cloud-init status --long 2>/dev/null || cloud-init status 2>/dev/null || true)",
    "if printf '%s' \"$status_text\" | grep -qiE '(^|[[:space:]])status:[[:space:]]*(done|degraded done)([[:space:]]|$)'; then exit 0; fi",
    "if printf '%s' \"$status_text\" | grep -qiE '(^|[[:space:]])extended_status:[[:space:]]*(done|degraded done)([[:space:]]|$)'; then exit 0; fi",
    "status_json=$(cloud-init status --format=json 2>/dev/null || true)",
    "if printf '%s' \"$status_json\" | grep -qiE '\"status\"[[:space:]]*:[[:space:]]*\"(done|degraded done)\"'; then exit 0; fi",
    "if printf '%s' \"$status_json\" | grep -qiE '\"extended_status\"[[:space:]]*:[[:space:]]*\"(done|degraded done)\"'; then exit 0; fi",
    "status_json=''",
    "if test -r /run/cloud-init/status.json; then status_json=$(cat /run/cloud-init/status.json 2>/dev/null || true); fi",
    "if printf '%s' \"$status_json\" | grep -qiE '\"status\"[[:space:]]*:[[:space:]]*\"done\"'; then exit 0; fi",
    "if printf '%s' \"$status_json\" | grep -qiE '\"extended_status\"[[:space:]]*:[[:space:]]*\"degraded done\"'; then exit 0; fi",
    "printf '%s\\n' \"cloud-init is not done: $status_text\" >&2",
    "exit 1"
  ].join('; ');

  while (Date.now() - startedAt < LINUX_SSH_WAIT_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Linux readiness wait aborted');
    }

    try {
      await runCommand(
        'timeout',
        [
          `${LINUX_SSH_ATTEMPT_TIMEOUT_SECONDS}s`,
          'sshpass',
          '-p',
          password,
          'ssh',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'LogLevel=ERROR',
          '-o',
          'ConnectTimeout=10',
          `${user}@${host}`,
          remoteCommand
        ],
        { signal }
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(computeReadinessRetryDelayMs(Date.now() - startedAt));
    }
  }

  throw new Error(
    `Timed out waiting for Linux guest ${host} to accept SSH and finish cloud-init${lastError ? `: ${lastError.message}` : ''}`
  );
};

// Checks every still-pending Windows VM in ONE ansible-playbook run per round (Ansible's own
// per-host forking handles the parallelism), instead of one dedicated ansible-playbook process
// per VM queued behind a fixed worker pool — a slow/stuck VM no longer blocks others from being
// checked. Each host needs two consecutive successful rounds at least WINDOWS_WINRM_STABLE_RECHECK_MS
// apart to be considered ready, mirroring the previous per-VM "stable recheck" behaviour.
const waitForWindowsBatchReadiness = async ({ targets, password, signal, onHostReady }) => {
  const startedAt = Date.now();
  const baseDir = path.join(tmpdir(), `labfactory-windows-readiness-${process.pid}-${Date.now()}`);
  await mkdir(baseDir, { recursive: true });

  const pending = new Map(targets.map(target => [Number(target.vmid), target]));
  const firstSuccessAtByVmid = new Map();
  let lastError = null;
  let roundIndex = 0;

  try {
    while (pending.size > 0) {
      if (Date.now() - startedAt >= WINDOWS_WINRM_WAIT_TIMEOUT_MS) {
        const stillPending = Array.from(pending.values()).map(target => target.name).join(', ');
        throw new Error(
          `Timed out waiting for Windows guests to accept stable WinRM and finish Cloudbase-Init: ${stillPending}${lastError ? ` (last error: ${lastError.message})` : ''}`
        );
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Windows readiness wait aborted');
      }

      const now = Date.now();
      const dueTargets = Array.from(pending.values()).filter(target => {
        const firstSuccessAt = firstSuccessAtByVmid.get(Number(target.vmid));
        return !firstSuccessAt || now - firstSuccessAt >= WINDOWS_WINRM_STABLE_RECHECK_MS;
      });

      if (dueTargets.length > 0) {
        const roundDir = path.join(baseDir, String(roundIndex));
        const inventoryPath = path.join(baseDir, `round-${roundIndex}.yml`);
        const playbookPath = path.join(baseDir, `round-${roundIndex}.playbook.yml`);
        await mkdir(roundDir, { recursive: true });
        await writeFile(inventoryPath, buildWindowsReadinessInventory(dueTargets, password), 'utf8');
        await writeFile(playbookPath, windowsCloudbaseReadinessPlaybook, 'utf8');

        try {
          await runCommand(
            'timeout',
            [
              `${WINDOWS_WINRM_ATTEMPT_TIMEOUT_SECONDS}s`,
              'ansible-playbook',
              '--inventory',
              inventoryPath,
              '--extra-vars',
              JSON.stringify({ marker_dir: roundDir }),
              playbookPath
            ],
            { cwd: terraformDir, env: { ...process.env }, signal }
          );
        } catch (error) {
          // Some hosts in this round may have failed/been unreachable — marker files (read below)
          // tell us which ones actually succeeded; the rest simply stay pending for the next round.
          lastError = error;
        }

        let readyHostKeys;
        try {
          readyHostKeys = new Set(await readdir(roundDir));
        } catch {
          readyHostKeys = new Set();
        }

        for (const target of dueTargets) {
          const vmid = Number(target.vmid);
          if (readyHostKeys.has(`vm_${vmid}`)) {
            const firstSuccessAt = firstSuccessAtByVmid.get(vmid);
            if (firstSuccessAt) {
              pending.delete(vmid);
              firstSuccessAtByVmid.delete(vmid);
              await onHostReady(target);
            } else {
              firstSuccessAtByVmid.set(vmid, Date.now());
            }
          } else {
            firstSuccessAtByVmid.delete(vmid);
          }
        }

        await Promise.all([
          rm(roundDir, { recursive: true, force: true }),
          rm(inventoryPath, { force: true }),
          rm(playbookPath, { force: true })
        ]);
      }

      if (pending.size === 0) {
        break;
      }
      roundIndex += 1;
      await sleep(computeReadinessRetryDelayMs(Date.now() - startedAt));
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
};

const buildWindowsReadinessTargets = blueprintVms =>
  (Array.isArray(blueprintVms) ? blueprintVms : [])
    .filter(vm => isWindowsOsType(vm.osType))
    .map(vm => ({
      vmid: vm.vmid,
      name: vm.name,
      host: buildStaticVmIpAddress(vm),
      user: String(vm.windowsAdminUsername ?? '').trim() || getWindowsAdminUsername(vm.language)
    }));

const buildLinuxReadinessTargets = blueprintVms =>
  (Array.isArray(blueprintVms) ? blueprintVms : [])
    .filter(vm => isLinuxCloudInitOsType(vm.osType) && vm.ipLastOctet != null && vm.subnetBase)
    .map(vm => ({
      vmid: vm.vmid,
      name: vm.name,
      host: buildStaticVmIpAddress(vm)
    }))
    .filter(target => target.host);

const buildLinuxReadinessTargetsWithoutHost = (blueprintVms, linuxReadinessTargets) =>
  (Array.isArray(blueprintVms) ? blueprintVms : [])
    .filter(vm => isLinuxCloudInitOsType(vm.osType))
    .filter(vm => !linuxReadinessTargets.some(target => Number(target.vmid) === Number(vm.vmid)));

const activateVmHaAfterReadiness = async ({ action, merged, target }) => {
  const haState = normalizeVmHaState(merged.vm_ha_state);
  if (action !== 'deploy' || !haState) {
    return;
  }

  await ensureVmHaState(merged, target.vmid, haState);
  console.log(`Activated Proxmox HA state "${haState}" for VMID ${target.vmid} after guest readiness`);
};

const waitForGuestReadiness = async ({
  action,
  targets,
  merged,
  job,
  terraformParallelism,
  abortController,
  readinessReporter
}) => {
  const windowsReadinessTargets = buildWindowsReadinessTargets(targets);
  const windowsReadinessTargetsWithoutHost = windowsReadinessTargets.filter(target => !target.host);
  if (windowsReadinessTargetsWithoutHost.length > 0) {
    throw new Error(
      `Unable to determine a static IPv4 address for Windows readiness checks: ${windowsReadinessTargetsWithoutHost
        .map(target => target.name)
        .join(', ')}`
    );
  }

  if (windowsReadinessTargets.length > 0) {
    const windowsPassword = String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim();
    if (!windowsPassword) {
      throw new Error('The blueprint windowsAdminPassword is required for Windows WinRM readiness checks');
    }
  }

  const linuxReadinessTargets = buildLinuxReadinessTargets(targets);
  const linuxReadinessTargetsWithoutHost = buildLinuxReadinessTargetsWithoutHost(targets, linuxReadinessTargets);
  if (linuxReadinessTargetsWithoutHost.length > 0) {
    throw new Error(
      `Unable to determine a static IPv4 address for Linux readiness checks: ${linuxReadinessTargetsWithoutHost
        .map(target => target.name)
        .join(', ')}`
    );
  }

  if (linuxReadinessTargets.length > 0) {
    const linuxPassword = String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim();
    if (!linuxPassword) {
      throw new Error('The blueprint windowsAdminPassword is required for Linux guest readiness checks');
    }
  }

  const readinessTasks = [];

  if (windowsReadinessTargets.length > 0) {
    const windowsPassword = String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim();
    console.log(`Waiting for ${windowsReadinessTargets.length} Windows guest(s) to respond over WinRM during ${action}`);
    readinessTasks.push(
      waitForWindowsBatchReadiness({
        targets: windowsReadinessTargets,
        password: windowsPassword,
        signal: abortController.signal,
        onHostReady: async target => {
          await activateVmHaAfterReadiness({ action, merged, target });
          await readinessReporter.markReady(target.vmid);
        }
      })
    );
  }

  if (linuxReadinessTargets.length > 0) {
    const linuxUser = String(merged.linux_default_username ?? '').trim() || 'ubuntu';
    const linuxPassword = String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim();
    console.log(`Waiting for ${linuxReadinessTargets.length} Linux guest(s) to respond over SSH during ${action}`);
    readinessTasks.push(
      ...linuxReadinessTargets.map(async target => {
        await waitForLinuxSshAndCloudInit({
          host: target.host,
          user: linuxUser,
          password: linuxPassword,
          signal: abortController.signal
        });
        await activateVmHaAfterReadiness({ action, merged, target });
        await readinessReporter.markReady(target.vmid);
      })
    );
  }

  await Promise.all(readinessTasks);
};

const createDeploymentReadinessReporter = job => {
  const targetVmids = normalizeVmids(
    Array.isArray(job.data?.replaceVmids) && job.data.replaceVmids.length > 0
      ? job.data.replaceVmids
      : Array.isArray(job.data?.blueprint?.vms)
        ? job.data.blueprint.vms.map(vm => vm.vmid)
        : []
  );
  const totalVmCount = targetVmids.length;
  const targetVmidSet = new Set(targetVmids);
  const startedVmids = new Set();
  const readyVmids = new Set();

  const publish = async () => {
    if (!job.data?.deploymentId) return;
    await job.updateProgress({
      type: 'guest-readiness',
      deploymentId: job.data.deploymentId,
      runId: job.data.runId,
      totalVmCount,
      startedCount: startedVmids.size,
      readyCount: readyVmids.size,
      targetVmids,
      startedVmids: Array.from(startedVmids).sort((a, b) => a - b),
      readyVmids: Array.from(readyVmids).sort((a, b) => a - b)
    });
  };

  return {
    publish,
    markStarted: async vmid => {
      const numericVmid = Number(vmid);
      if (Number.isInteger(numericVmid) && targetVmidSet.has(numericVmid)) {
        startedVmids.add(numericVmid);
      }
      await publish();
    },
    markStartedAll: async () => {
      for (const vmid of targetVmidSet) {
        startedVmids.add(vmid);
      }
      await publish();
    },
    markReady: async vmid => {
      const numericVmid = Number(vmid);
      if (Number.isInteger(numericVmid) && targetVmidSet.has(numericVmid)) {
        startedVmids.add(numericVmid);
        readyVmids.add(numericVmid);
      }
      await publish();
    }
  };
};

export const terraformQueueName = 'terraform-workflows';

export function startTerraformWorker(connection) {
  const activeAbortControllers = new Map();
  const ansibleQueue = new Queue(ansibleQueueName, { connection });
  const terraformQueue = new Queue(terraformQueueName, { connection });

  const worker = new Worker(
    terraformQueueName,
    async job => {
      const abortController = new AbortController();
      // Many VMs are polled concurrently for guest readiness, each holding an abort listener
      // on this shared signal — raise Node's default threshold (10) to match expected concurrency.
      setMaxListeners(128, abortController.signal);
      activeAbortControllers.set(String(job.id), abortController);
      const readinessReporter = createDeploymentReadinessReporter(job);
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
      const deploymentLabel = job.data.deploymentNumber ? `#${job.data.deploymentNumber}` : String(job.data.labInstanceId);
      try {
        console.log(`Terraform job ${job.id} started for deployment ${deploymentLabel} (${action})`);
        const terraformParallelism = resolveTerraformParallelism();
        const replaceVmids = normalizeVmids(job.data?.replaceVmids);
        const replaceArgs = action === 'deploy' ? buildTerraformReplaceArgs(replaceVmids) : [];
        const targetArgs = action === 'deploy' && replaceVmids.length > 0 ? buildTerraformTargetArgs(replaceVmids) : [];
        const inProgressStatus =
          action === 'destroy'
            ? 'destroying'
            : action === 'start'
              ? 'starting'
              : action === 'stop'
                ? 'stopping'
                : 'deploying';
        const statusClaimed = await safeUpdateLifecycleStatus(job.data.labInstanceId, inProgressStatus, {
          action,
          jobId: String(job.id),
          runId: job.data.runId
        });
        if (!statusClaimed) {
          console.log(`Skipping stale Terraform job ${job.id} for deployment ${deploymentLabel} (${action})`);
          return {
            planOutput: '',
            labInstanceId: job.data.labInstanceId,
            runId: job.data.runId,
            status: 'stale-job-skipped'
          };
        }
        if (action === 'deploy') {
          await readinessReporter.publish();
        }

      let preparedVarFile;
      let merged;
      try {
          const blueprintWindowsAdminPassword = String(job.data?.blueprint?.windowsAdminPassword ?? '').trim();
          const jobWindowsAdminPassword = String(job.data?.windowsAdminPassword ?? '').trim();
          const resolvedWindowsAdminPassword = jobWindowsAdminPassword || blueprintWindowsAdminPassword;
          if (jobWindowsAdminPassword && blueprintWindowsAdminPassword && jobWindowsAdminPassword !== blueprintWindowsAdminPassword) {
            throw new Error('Terraform job password does not match blueprint windowsAdminPassword');
          }
          const raw = await readFile(terraformVarsPath, 'utf8');
          const rawSettings = JSON.parse(raw);
          const sanitized = sanitizeSettingsInput(rawSettings);
          const envSettings = readTerraformEnvSettings();
          merged = { ...defaultTerraformSettings, ...sanitized, ...envSettings };
          assertRequiredTerraformEnvSettings(merged);
          merged.proxmox_nodes = await resolveProxmoxTargetNodes(merged);
          merged.proxmox_parallel = terraformParallelism;
          merged.network_vlan_mask = job.data?.blueprint?.networkVlanMask ?? merged.network_vlan_mask;
          const networkGateway = job.data?.blueprint?.networkGateway ?? merged.network_gateway;
          merged.linux_default_username = String(job.data?.linuxDefaultUsername ?? job.data?.blueprint?.linuxDefaultUsername ?? '').trim() || 'ubuntu';
          if (Array.isArray(job.data?.blueprint?.vms) && job.data.blueprint.vms.length > 0) {
            const resolvedBlueprintVms = await resolveTemplateNamesByVmid(
              merged,
              job.data.blueprint.vms
            );
            merged.vm_definitions = resolvedBlueprintVms.map(vm => ({
              vmid: Number(vm.vmid),
              name: vm.name,
              hostname: vm.customNameEnabled ? String(vm.hostname ?? '').trim() || null : null,
              os_type: vm.osType ?? 'other',
              language: String(vm.language ?? 'en').trim().toLowerCase() || 'en',
              windows_admin_username: String(vm.windowsAdminUsername ?? '').trim() || null,
              clone_source: String(vm.cloneSource),
              full_clone: Boolean(vm.fullClone),
              ip_last_octet: vm.ipLastOctet == null ? null : Number(vm.ipLastOctet),
              ipconfig0: buildCloudInitIpConfig({
                subnetBase: vm.subnetBase,
                mask: merged.network_vlan_mask,
                ipLastOctet: vm.ipLastOctet == null ? null : Number(vm.ipLastOctet),
                gatewayIp: networkGateway
              }),
              disk_type: vm.diskType ?? null,
              disk_slot: vm.diskSlot ?? null,
              disk_storage: vm.diskStorage ?? null,
              disk_size: vm.diskSize ?? null,
              secondary_disk_slot: vm.secondDiskSizeGb ? vm.secondDiskSlot : null,
              secondary_disk_storage: vm.secondDiskSizeGb ? vm.diskStorage : null,
              secondary_disk_size: vm.secondDiskSizeGb ? `${vm.secondDiskSizeGb}G` : null,
              cloudinit_slot: vm.cloudinitSlot ?? null,
              cloudinit_storage: vm.cloudinitStorage ?? null,
              bios: vm.bios ?? null,
              machine: vm.machine ?? null,
              tags: mergeVmTags(vm.tags, job.data.deploymentNumber == null ? null : String(job.data.deploymentNumber)),
              vlan_tag: Number(vm.vlanTag ?? merged.network_vlan_tag ?? 0)
            }));
          }
          const hasWindowsVm = Array.isArray(merged.vm_definitions)
            && merged.vm_definitions.some(vm => isWindowsOsType(vm.os_type));
          merged.windows_admin_password = resolvedWindowsAdminPassword;
          if (hasWindowsVm && !String(merged.windows_admin_password ?? '').trim()) {
            throw new Error(
              'windows_admin_password must be set on the blueprint before deploying a Windows template with Cloudbase-Init wait'
            );
          }
          delete merged.network_gateway;
          await writeFile(sanitizedVarsPath, JSON.stringify(merged, null, 2));
          preparedVarFile = sanitizedVarsPath;

          if (action === 'start' || action === 'stop') {
            const desiredAction = action === 'start' ? 'start' : 'shutdown';
            const blueprintVms = Array.isArray(job.data?.blueprint?.vms) ? job.data.blueprint.vms : [];
            const stopVerificationOnly = action === 'stop' && job.data?.stopVerificationOnly === true;

            if (stopVerificationOnly) {
              const currentDeploymentState = await fetchDeploymentLifecycleState(job.data.labInstanceId);
              const currentRunId = String(currentDeploymentState?.lastRunId ?? '').trim();
              const expectedRunId = String(job.data.runId ?? '').trim();
              if (
                !currentDeploymentState
                || currentDeploymentState.status !== 'stopping'
                || (expectedRunId && currentRunId && currentRunId !== expectedRunId)
              ) {
                console.log(
                  `Skipping stale stop verification for deployment ${deploymentLabel} (status=${currentDeploymentState?.status ?? 'missing'}, runId=${currentRunId || 'n/a'})`
                );
                return {
                  planOutput: '',
                  labInstanceId: job.data.labInstanceId,
                  runId: job.data.runId,
                  status: 'stop-verification-skipped'
                };
              }
            }

            if (!stopVerificationOnly) {
              const vmNodeByVmid = await resolveVmNodesByVmid(
                merged,
                blueprintVms.map(vm => vm.vmid),
                { allowMissing: action === 'stop' }
              );
              const powerActionTargets = blueprintVms.filter(vm => vmNodeByVmid.has(Number(vm.vmid)));
              await runWithConcurrency(powerActionTargets, terraformParallelism, async vm => {
                await requestVmPowerState(
                  merged,
                  vmNodeByVmid.get(Number(vm.vmid)),
                  vm.vmid,
                  desiredAction
                );
              });
            }

            if (action === 'stop') {
              const allStopped = await waitForVmPowerState({
                envSettings: merged,
                vmids: blueprintVms.map(vm => vm.vmid),
                desiredState: 'stopped',
                signal: abortController.signal,
                timeoutMs: STOP_STATE_CONFIRMATION_TIMEOUT_MS,
                returnOnTimeout: true
              });

              if (!allStopped) {
                const stopRetryCount = Number(job.data?.stopRetryCount ?? 0);
                if (stopRetryCount < STOP_STATE_MAX_RETRIES) {
                  const followupJob = await terraformQueue.add(
                    'stop',
                    {
                      ...job.data,
                      action: 'stop',
                      stopVerificationOnly: true,
                      stopRetryCount: stopRetryCount + 1
                    },
                    {
                      attempts: 1,
                      delay: STOP_STATE_RECHECK_DELAY_MS
                    }
                  );
                  await safeUpdateLifecycleStatus(
                    job.data.labInstanceId,
                    'stopping',
                    {
                      action,
                      jobId: String(followupJob.id),
                      runId: job.data.runId
                    }
                  );
                  console.log(
                    `Stop still in progress for deployment ${deploymentLabel}; scheduled verification retry ${stopRetryCount + 1}/${STOP_STATE_MAX_RETRIES} in ${Math.round(STOP_STATE_RECHECK_DELAY_MS / 1000)}s`
                  );
                } else {
                  console.warn(`Stop still in progress for deployment ${deploymentLabel} after ${STOP_STATE_MAX_RETRIES} verification retries; keeping status stopping`);
                  await safeUpdateLifecycleStatus(job.data.labInstanceId, 'stopping', {
                    action,
                    jobId: String(job.id),
                    runId: job.data.runId
                  });
                }

                return {
                  planOutput: '',
                  labInstanceId: job.data.labInstanceId,
                  runId: job.data.runId,
                  status: 'stop-pending'
                };
              }
            }

            if (action === 'start') {
              await waitForVmPowerState({
                envSettings: merged,
                vmids: blueprintVms.map(vm => vm.vmid),
                desiredState: 'running',
                signal: abortController.signal
              });
              await readinessReporter.markStartedAll();
              await waitForGuestReadiness({
                action,
                targets: blueprintVms,
                merged,
                job,
                terraformParallelism,
                abortController,
                readinessReporter
              });
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

        const blueprintVms = Array.isArray(job.data?.blueprint?.vms) ? job.data.blueprint.vms : [];
        const scopedBlueprintVms =
          replaceVmids.length > 0
            ? blueprintVms.filter(vm => replaceVmids.includes(Number(vm.vmid)))
            : blueprintVms;

        await runCommand('terraform', ['init', '-input=false'], {
          cwd: terraformDir,
          env,
          signal: abortController.signal
        });
        try {
          await runCommand('terraform', ['workspace', 'select', workspaceName], {
            cwd: terraformDir,
            env,
            signal: abortController.signal
          });
        } catch {
          await runCommand('terraform', ['workspace', 'new', workspaceName], {
            cwd: terraformDir,
            env,
            signal: abortController.signal
          });
        }

        let planOutput = '';
        if (action === 'destroy') {
          planOutput = await runCommand(
            'terraform',
            ['destroy', '-auto-approve', '-input=false', `-parallelism=${terraformParallelism}`, `-var-file=${preparedVarFile}`],
            { cwd: terraformDir, env, signal: abortController.signal }
          );
          await cleanupDestroyedVmVolumes(merged, merged.vm_definitions).catch(error => {
            console.warn(`Post-destroy volume cleanup failed for deployment ${deploymentLabel} (${formatProxmoxError(error)})`);
          });
        } else {
          const planAndApply = async () => {
            const output = await runCommand(
              'terraform',
              ['plan', '-out=tfplan', '-input=false', `-parallelism=${terraformParallelism}`, `-var-file=${preparedVarFile}`, ...replaceArgs, ...targetArgs],
              { cwd: terraformDir, env, signal: abortController.signal }
            );
            await runCommand(
              'terraform',
              ['apply', '-auto-approve', `-parallelism=${terraformParallelism}`, 'tfplan'],
              { cwd: terraformDir, env, signal: abortController.signal }
            );
            return output;
          };

          try {
            planOutput = await planAndApply();
          } catch (error) {
            throw error;
          }
        }

        if (action === 'deploy') {
          await readinessReporter.markStartedAll();
          await waitForGuestReadiness({
            action,
            targets: scopedBlueprintVms,
            merged,
            job,
            terraformParallelism,
            abortController,
            readinessReporter
          });
        }

        const customizationTargets = Array.isArray(job.data?.blueprint?.vms)
          ? scopedBlueprintVms
              .filter(
                vm =>
                  (
                    String(vm.timezone ?? '').trim() ||
                    String(vm.hostname ?? '').trim() ||
                    String(vm.domainRole ?? '').trim() ||
                    vm.installDocker ||
                    (vm.secondDiskSizeGb && vm.secondDiskConfigure)
                  ) &&
                  [isWindowsOsType(vm.osType), isLinuxOsType(vm.osType)].some(Boolean)
              )
              .map(vm => ({
                id: vm.id,
                vmid: Number(vm.vmid),
                name: vm.name,
                hostname: String(vm.hostname ?? '').trim() || null,
                language: String(vm.language ?? '').trim().toLowerCase() || 'en',
                windowsAdminUsername: String(vm.windowsAdminUsername ?? '').trim() || null,
                ipAddress:
                  vm.ipLastOctet != null && vm.subnetBase
                    ? `${String(vm.subnetBase).split('.').slice(0, 3).join('.')}.${Number(vm.ipLastOctet)}`
                    : null,
                timezone: String(vm.timezone ?? '').trim() || null,
                domainRole: String(vm.domainRole ?? '').trim() || null,
                domainName: String(vm.domainName ?? '').trim() || null,
                installDocker: Boolean(vm.installDocker),
                secondDiskSizeGb: vm.secondDiskSizeGb ?? null,
                secondDiskConfigure: Boolean(vm.secondDiskConfigure),
                osType: vm.osType ?? 'other'
              }))
          : [];

        if (action === 'deploy' && job.data?.deploymentId && customizationTargets.length > 0) {
          const ansibleJob = await ansibleQueue.add(
            'customize-timezone',
            {
              action: 'customize',
              labInstanceId: job.data.labInstanceId,
              deploymentNumber: job.data.deploymentNumber,
              deploymentId: job.data.deploymentId,
              runId: job.data.runId,
              blueprint: {
                name: job.data?.blueprint?.name ?? null,
                classroomName: job.data?.blueprint?.classroomName ?? null,
                windowsAdminPassword: String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim()
              },
              linuxDefaultUsername: String(job.data?.linuxDefaultUsername ?? merged.linux_default_username ?? '').trim() || 'ubuntu',
              windowsAdminPassword: String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim(),
              timezoneTargets: customizationTargets
            },
            { attempts: 1 }
          );

          await safeUpdateLifecycleStatus(job.data.labInstanceId, 'customizing', {
            action: 'customize',
            jobId: String(ansibleJob.id),
            runId: job.data.runId
          });
        } else {
          await safeUpdateLifecycleStatus(job.data.labInstanceId, action === 'destroy' ? 'destroyed' : 'deployed', {
            action,
            jobId: String(job.id),
            runId: job.data.runId
          });
        }

        console.log(`Terraform job ${job.id} finished for deployment ${deploymentLabel} (${action})`);

        return {
          planOutput,
          labInstanceId: job.data.labInstanceId,
          runId: job.data.runId
        };
      } catch (error) {
        console.error(`Terraform job ${job.id} failed for deployment ${deploymentLabel} (${action})`, error);
        await safeUpdateLifecycleStatus(job.data.labInstanceId, 'failed', {
          action,
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
      const job = await terraformQueue.getJob(jobId);
      if (job?.data?.labInstanceId) {
        await safeUpdateLifecycleStatus(job.data.labInstanceId, 'failed', {
          action: job.data.action ?? 'deploy',
          jobId: String(jobId),
          runId: job.data.runId
        });
        console.warn(`[stalled] Terraform job ${jobId} → deployment ${job.data.labInstanceId} marqué failed`);
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

export async function resetStalledTerraformDeployments() {
  const transient = ['queued', 'deploying', 'destroying', 'starting', 'stopping'];
  try {
    const result = await dbPool.query(
      `UPDATE lab_deployments
         SET status = 'failed', last_action = 'worker-restarted', updated_at = NOW()
       WHERE status = ANY($1::text[])`,
      [transient]
    );
    if (result.rowCount > 0) {
      console.log(`[startup] ${result.rowCount} déploiement(s) bloqué(s) remis à failed`);
    }
  } catch (err) {
    console.error('[startup] Impossible de réinitialiser les déploiements bloqués:', err);
  }
}
