import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  assertRequiredTerraformEnvSettings,
  defaultTerraformSettings,
  readTerraformEnvSettings,
  sanitizeSettingsInput
} from '../lib/terraformSettings.js';
import {
  addVmToPool,
  buildUpdatedNet0Config,
  cloneQemuVm,
  ensurePool,
  fetchProxmoxVmResources,
  fetchVmConfig,
  formatProxmoxError,
  isProxmoxTemplate,
  resolveProxmoxTaskNode,
  resolveProxmoxTargetNodes,
  resolveVmByDirectConfigLookup,
  resolveVmNodeByVmid,
  startQemuVm,
  updateQemuVmConfig,
  waitForProxmoxTask
} from '../lib/proxmoxApi.js';
import {
  assertVmPoolProvisioningConfig,
  buildCloudInitIpConfig,
  buildPoolVmTags,
  getVmPoolConfig,
  listPoolIpAddresses
} from '../lib/vmPoolConfig.js';
import {
  getWindowsAdminUsername,
  isWindowsOsType,
  waitForWindowsHostReadiness
} from '../lib/guestReadiness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const terraformVarsPath = path.resolve(__dirname, '../config/terraform-settings.json');
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory'
});

const MANAGER_LOCK_KEY = 'labfactory-vm-pool-manager';

const readMergedTerraformSettings = async () => {
  const raw = await readFile(terraformVarsPath, 'utf8');
  const rawSettings = JSON.parse(raw);
  const sanitized = sanitizeSettingsInput(rawSettings);
  const envSettings = readTerraformEnvSettings();
  const merged = { ...defaultTerraformSettings, ...sanitized, ...envSettings };
  assertRequiredTerraformEnvSettings(merged);
  merged.proxmox_nodes = await resolveProxmoxTargetNodes(merged);
  return merged;
};

const sanitizeVmName = input =>
  String(input ?? 'pool-vm')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'pool-vm';

const acquireManagerLock = async client => {
  const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [MANAGER_LOCK_KEY]);
  return result.rows[0]?.locked === true;
};

const releaseManagerLock = async client => {
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MANAGER_LOCK_KEY]);
};

const fetchPoolTemplates = async client => {
  const result = await client.query(
    `SELECT
       id,
       name,
       os_type,
       language,
       proxmox_template_vmid,
       full_clone,
       pool_target_ready_count
     FROM vm_templates
     WHERE pool_target_ready_count > 0
       AND os_type IN ('windows11', 'windows-server')
     ORDER BY LOWER(name) ASC`
  );
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    osType: row.os_type,
    language: row.language ?? 'en',
    proxmoxTemplateVmid: Number(row.proxmox_template_vmid),
    fullClone: Boolean(row.full_clone),
    poolTargetReadyCount: Number(row.pool_target_ready_count)
  }));
};

const fetchPoolCounts = async client => {
  const result = await client.query(
    `SELECT
       template_id,
       status,
       COUNT(*)::int AS count
     FROM vm_pool_instances
     WHERE status IN ('preparing', 'ready')
     GROUP BY template_id, status`
  );
  const counts = new Map();
  for (const row of result.rows) {
    if (!counts.has(row.template_id)) {
      counts.set(row.template_id, { preparing: 0, ready: 0 });
    }
    counts.get(row.template_id)[row.status] = Number(row.count);
  }
  return counts;
};

const fetchUsedPoolVmids = async client => {
  const result = await client.query(
    `SELECT proxmox_vmid
       FROM vm_pool_instances`
  );
  return new Set(result.rows.map(row => Number(row.proxmox_vmid)).filter(Number.isInteger));
};

const fetchUsedPoolIps = async client => {
  const result = await client.query(
    `SELECT pool_ip_address
       FROM vm_pool_instances
      WHERE pool_ip_address IS NOT NULL
        AND status IN ('preparing', 'ready', 'reserved')`
  );
  return new Set(result.rows.map(row => String(row.pool_ip_address ?? '').trim()).filter(Boolean));
};

const chooseFreeVmid = ({ poolConfig, usedVmids }) => {
  for (let vmid = poolConfig.vmidStart; vmid <= poolConfig.vmidEnd; vmid += 1) {
    if (!usedVmids.has(vmid)) {
      usedVmids.add(vmid);
      return vmid;
    }
  }
  throw new Error(`No free VMID available in VM pool range ${poolConfig.vmidStart}-${poolConfig.vmidEnd}`);
};

const chooseFreePoolIp = ({ poolConfig, usedIps }) => {
  for (const ipAddress of listPoolIpAddresses(poolConfig)) {
    if (!usedIps.has(ipAddress)) {
      usedIps.add(ipAddress);
      return ipAddress;
    }
  }
  throw new Error('No free IP address available in VM pool preparation range');
};

const resolveTemplateNode = async (envSettings, templateVmid, resources) => {
  const resource = resources.find(item => Number(item.vmid) === Number(templateVmid));
  if (resource?.node) {
    if (!isProxmoxTemplate(resource.template)) {
      throw new Error(`Proxmox VMID ${templateVmid} is not marked as a template`);
    }
    return String(resource.node);
  }

  const { match, failures } = await resolveVmByDirectConfigLookup(envSettings, templateVmid);
  if (!match?.node) {
    throw new Error(
      `Unable to resolve Proxmox node for template VMID ${templateVmid}: ${failures.map(failure => `${failure.node}: ${failure.message}`).join('; ')}`
    );
  }
  if (!match.template) {
    throw new Error(`Proxmox VMID ${templateVmid} is not marked as a template`);
  }
  return match.node;
};

const markPoolInstance = async (id, patch) => {
  const fields = [];
  const values = [id];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = $${values.length + 1}`);
    values.push(value);
  }
  fields.push('updated_at = NOW()');
  await dbPool.query(
    `UPDATE vm_pool_instances
        SET ${fields.join(', ')}
      WHERE id = $1`,
    values
  );
};

const createPoolInstance = async ({ template, envSettings, poolConfig, resources, usedVmids, usedIps }) => {
  const id = uuidv4();
  const vmid = chooseFreeVmid({ poolConfig, usedVmids });
  const ipAddress = chooseFreePoolIp({ poolConfig, usedIps });
  const sourceNode = await resolveTemplateNode(envSettings, template.proxmoxTemplateVmid, resources);
  const targetNodes = Array.isArray(envSettings.proxmox_nodes) && envSettings.proxmox_nodes.length
    ? envSettings.proxmox_nodes
    : [sourceNode];
  const targetNode = targetNodes[(vmid - poolConfig.vmidStart) % targetNodes.length] || sourceNode;
  const name = sanitizeVmName(`pool-${template.proxmoxTemplateVmid}-${vmid}`);
  const username = getWindowsAdminUsername(template.language);
  const ipconfig0 = buildCloudInitIpConfig({
    ipAddress,
    networkMask: poolConfig.networkMask,
    gateway: poolConfig.gateway
  });

  await dbPool.query(
    `INSERT INTO vm_pool_instances
      (id, template_id, proxmox_template_vmid, proxmox_vmid, name, node, pool_name,
       pool_ip_address, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'preparing', NOW(), NOW())`,
    [
      id,
      template.id,
      template.proxmoxTemplateVmid,
      vmid,
      name,
      targetNode,
      poolConfig.poolName,
      ipAddress
    ]
  );

  try {
    await ensurePool(envSettings, poolConfig.poolName);
    console.log(`Creating pooled VM ${name} (VMID ${vmid}) from template ${template.proxmoxTemplateVmid}`);
    const cloneTask = await cloneQemuVm(envSettings, {
      sourceNode,
      sourceVmid: template.proxmoxTemplateVmid,
      newid: vmid,
      name,
      targetNode,
      fullClone: template.fullClone,
      poolName: poolConfig.poolName
    });
    await waitForProxmoxTask(envSettings, resolveProxmoxTaskNode(cloneTask, sourceNode), cloneTask);

    const node = await resolveVmNodeByVmid(envSettings, vmid) || targetNode;
    const currentConfig = await fetchVmConfig(envSettings, node, vmid);
    const net0 = buildUpdatedNet0Config({
      existingNet0: currentConfig.net0,
      bridge: envSettings.network_bridge,
      firewall: Boolean(envSettings.network_firewall),
      vlanTag: poolConfig.vlanTag
    });

    await updateQemuVmConfig(envSettings, node, vmid, {
      name,
      agent: 1,
      onboot: 0,
      ciuser: username,
      cipassword: poolConfig.windowsAdminPassword,
      ipconfig0,
      tags: buildPoolVmTags(template.proxmoxTemplateVmid),
      net0
    });
    await addVmToPool(envSettings, poolConfig.poolName, vmid);
    await markPoolInstance(id, { node });

    const startTask = await startQemuVm(envSettings, node, vmid);
    await waitForProxmoxTask(envSettings, resolveProxmoxTaskNode(startTask, node), startTask);

    await waitForWindowsHostReadiness({
      target: {
        vmid,
        name,
        host: ipAddress,
        user: username
      },
      password: poolConfig.windowsAdminPassword
    });

    await updateQemuVmConfig(envSettings, node, vmid, {
      tags: buildPoolVmTags(template.proxmoxTemplateVmid)
    });
    await markPoolInstance(id, { status: 'ready', last_error: null });
    console.log(`Pooled VM ${name} (VMID ${vmid}) is ready`);
    return { id, vmid, status: 'ready' };
  } catch (error) {
    const message = formatProxmoxError(error);
    console.error(`Unable to prepare pooled VM ${name} (VMID ${vmid}): ${message}`);
    await markPoolInstance(id, { status: 'failed', last_error: message });
    return { id, vmid, status: 'failed', error: message };
  }
};

export const runVmPoolManagerOnce = async () => {
  const poolConfig = getVmPoolConfig();
  assertVmPoolProvisioningConfig(poolConfig);
  const client = await dbPool.connect();
  let locked = false;

  try {
    locked = await acquireManagerLock(client);
    if (!locked) {
      console.log('VM pool manager skipped: another instance holds the lock');
      return { skipped: true, created: 0 };
    }

    const [envSettings, templates, counts, dbUsedVmids, usedIps] = await Promise.all([
      readMergedTerraformSettings(),
      fetchPoolTemplates(client),
      fetchPoolCounts(client),
      fetchUsedPoolVmids(client),
      fetchUsedPoolIps(client)
    ]);
    if (!templates.length) {
      return { skipped: false, created: 0 };
    }

    const resources = await fetchProxmoxVmResources(envSettings);
    const usedVmids = new Set([
      ...dbUsedVmids,
      ...resources.map(resource => Number(resource.vmid)).filter(Number.isInteger)
    ]);

    const plan = [];
    for (const template of templates) {
      if (!isWindowsOsType(template.osType)) {
        continue;
      }
      const templateCounts = counts.get(template.id) ?? { preparing: 0, ready: 0 };
      const currentCapacity = templateCounts.ready + templateCounts.preparing;
      const deficit = Math.max(0, template.poolTargetReadyCount - currentCapacity);
      for (let index = 0; index < deficit; index += 1) {
        plan.push(template);
      }
    }

    const selected = plan.slice(0, poolConfig.batchSize);
    for (const template of selected) {
      await createPoolInstance({
        template,
        envSettings,
        poolConfig,
        resources,
        usedVmids,
        usedIps
      });
    }

    return { skipped: false, created: selected.length };
  } finally {
    if (locked) {
      await releaseManagerLock(client).catch(error => {
        console.warn(`Unable to release VM pool manager lock: ${formatProxmoxError(error)}`);
      });
    }
    client.release();
  }
};

export const startVmPoolManager = ({ intervalMs } = {}) => {
  const poolConfig = getVmPoolConfig();
  let running = false;
  let paused = false;
  let stopped = false;

  const run = async () => {
    if (running || paused || stopped) {
      return;
    }
    running = true;
    try {
      await runVmPoolManagerOnce();
    } catch (error) {
      console.error(`VM pool manager run failed: ${formatProxmoxError(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(run, intervalMs ?? poolConfig.runIntervalMs);
  setTimeout(run, 1000);

  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      setTimeout(run, 0);
    },
    runNow: run,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      while (running) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  };
};
