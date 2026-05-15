import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import { runCommand } from '../lib/runCommand.js';
import { readFile, writeFile } from 'node:fs/promises';
import { ansibleQueueName } from './ansibleWorker.js';
import {
  assertRequiredTerraformEnvSettings,
  defaultTerraformSettings,
  readTerraformEnvSettings,
  sanitizeSettingsInput
} from '../lib/terraformSettings.js';

const LINUX_SSH_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const LINUX_SSH_WAIT_RETRY_MS = 5000;
const LINUX_SSH_ATTEMPT_TIMEOUT_SECONDS = 45;
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
        cloudinitSlot: cloudInitConfig.cloudinitSlot,
        cloudinitStorage: cloudInitConfig.cloudinitStorage,
        bios: firmwareConfig.bios,
        machine: firmwareConfig.machine
      }
    ];
  }, Promise.resolve([]));
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

const resolveVmNodesByVmid = async (envSettings, vmids) => {
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

const safeUpdateLifecycleStatus = async (blueprintId, status, details = {}) => {
  try {
    await updateLifecycleStatus(blueprintId, status, details);
  } catch (error) {
    console.error(`Unable to update lifecycle status to ${status} for ${blueprintId}`, error);
  }
};

const workspaceNameFor = blueprintId => `blueprint-${String(blueprintId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
const isWindowsOsType = osType => ['windows11', 'windows-server'].includes(String(osType ?? '').trim());
const isLinuxOsType = osType => !isWindowsOsType(osType);

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForLinuxSshAndCloudInit = async ({ host, user, password, signal }) => {
  const startedAt = Date.now();
  let lastError = null;
  const remoteCommand =
    "test -f /var/lib/cloud/instance/boot-finished || (command -v cloud-init >/dev/null 2>&1 && cloud-init status --wait >/dev/null 2>&1) || true";

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
      await sleep(LINUX_SSH_WAIT_RETRY_MS);
    }
  }

  throw new Error(
    `Timed out waiting for Linux guest ${host} to accept SSH and finish cloud-init${lastError ? `: ${lastError.message}` : ''}`
  );
};

export const terraformQueueName = 'terraform-workflows';

export function startTerraformWorker(connection) {
  const activeAbortControllers = new Map();
  const ansibleQueue = new Queue(ansibleQueueName, { connection });

  const worker = new Worker(
    terraformQueueName,
    async job => {
      const abortController = new AbortController();
      activeAbortControllers.set(String(job.id), abortController);
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
            const vmNodeByVmid = await resolveVmNodesByVmid(
              merged,
              blueprintVms.map(vm => vm.vmid)
            );
            await runWithConcurrency(blueprintVms, terraformParallelism, async vm => {
              await invokeVmPowerAction(
                merged,
                vmNodeByVmid.get(Number(vm.vmid)),
                vm.vmid,
                desiredAction
              );
            });

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
        } else {
          planOutput = await runCommand(
            'terraform',
            ['plan', '-out=tfplan', '-input=false', `-parallelism=${terraformParallelism}`, `-var-file=${preparedVarFile}`],
            { cwd: terraformDir, env, signal: abortController.signal }
          );
          await runCommand(
            'terraform',
            ['apply', '-auto-approve', `-parallelism=${terraformParallelism}`, 'tfplan'],
            { cwd: terraformDir, env, signal: abortController.signal }
          );
        }

        const linuxReadinessTargets = Array.isArray(job.data?.blueprint?.vms)
          ? job.data.blueprint.vms
              .filter(vm => isLinuxOsType(vm.osType) && vm.ipLastOctet != null && vm.subnetBase)
              .map(vm => ({
                name: vm.name,
                host: `${String(vm.subnetBase).split('.').slice(0, 3).join('.')}.${Number(vm.ipLastOctet)}`
              }))
          : [];

        if (action === 'deploy' && linuxReadinessTargets.length > 0) {
          const linuxUser = String(merged.linux_default_username ?? '').trim() || 'ubuntu';
          const linuxPassword = String(job.data?.windowsAdminPassword ?? job.data?.blueprint?.windowsAdminPassword ?? '').trim();
          if (!linuxPassword) {
            throw new Error('The blueprint windowsAdminPassword is required for Linux guest readiness checks');
          }

          await runWithConcurrency(linuxReadinessTargets, terraformParallelism, async target => {
            console.log(`Waiting for Linux guest ${target.name} (${target.host}) to finish cloud-init`);
            await waitForLinuxSshAndCloudInit({
              host: target.host,
              user: linuxUser,
              password: linuxPassword,
              signal: abortController.signal
            });
          });
        }

        const customizationTargets = Array.isArray(job.data?.blueprint?.vms)
          ? job.data.blueprint.vms
              .filter(
                vm =>
                  (
                    String(vm.timezone ?? '').trim() ||
                    String(vm.hostname ?? '').trim()
                  ) &&
                  [isWindowsOsType(vm.osType), isLinuxOsType(vm.osType)].some(Boolean)
              )
              .map(vm => ({
                id: vm.id,
                name: vm.name,
                hostname: String(vm.hostname ?? '').trim() || null,
                language: String(vm.language ?? '').trim().toLowerCase() || 'en',
                windowsAdminUsername: String(vm.windowsAdminUsername ?? '').trim() || null,
                ipAddress:
                  vm.ipLastOctet != null && vm.subnetBase
                    ? `${String(vm.subnetBase).split('.').slice(0, 3).join('.')}.${Number(vm.ipLastOctet)}`
                    : null,
                timezone: String(vm.timezone).trim(),
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

  worker.cancelActiveJobs = async () => {
    for (const controller of activeAbortControllers.values()) {
      controller.abort(new Error('Job cancelled from dashboard clear history action'));
    }
  };

  return worker;
}
