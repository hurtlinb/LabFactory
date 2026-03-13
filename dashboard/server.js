import 'dotenv/config';
import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import { createClient } from 'redis';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { redisConnectionOptions } from '../config/redis.js';
import {
  sanitizeSettingsInput,
  defaultTerraformSettings,
  readTerraformEnvSettings,
  assertRequiredTerraformEnvSettings
} from '../lib/terraformSettings.js';

const require = createRequire(import.meta.url);
const { Queue } = require('bullmq');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = Number(process.env.PORT || 3000);
const connection = redisConnectionOptions();
const queueNames = {
  terraform: 'terraform-workflows',
  ansible: 'ansible-workflows'
};
const queues = Object.fromEntries(
  Object.entries(queueNames).map(([key, name]) => [key, new Queue(name, { connection })])
);
const queueRetention = {
  removeOnComplete: 50,
  removeOnFail: 50
};

const redisClient = createClient({
  socket: { host: connection.host, port: connection.port },
  password: connection.password
});

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://labfactory:labfactory@localhost:5432/labfactory'
});

const settingsDir = path.resolve(__dirname, '../config');
const terraformSettingsPath = path.join(settingsDir, 'terraform-settings.json');
const terraformSettingsSamplePath = path.join(settingsDir, 'terraform-settings.sample.json');
const migrationsDir = path.resolve(__dirname, '../db/migrations');

const wrapAsync =
  handler =>
  (req, res) =>
    Promise.resolve(handler(req, res)).catch(err => {
      console.error('Unhandled request error', err);
      res.status(500).json({ error: 'internal server error' });
    });

const templateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional().default(''),
  osType: z.enum(['windows11', 'windows-server', 'ubuntu', 'other']),
  proxmoxTemplateVmid: z.number().int().positive(),
  fullClone: z.boolean().optional().default(false),
});

const blueprintVmSchema = z.object({
  id: z.string().uuid().optional(),
  templateId: z.string().uuid(),
  name: z.string().trim().min(1),
  ipLastOctet: z.number().int().min(1).max(254).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional().default({})
});

const blueprintSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional().default(''),
  status: z.enum(['draft', 'ready', 'archived']).optional().default('draft'),
  vms: z.array(blueprintVmSchema).min(1)
});

const classroomSchema = z.object({
  name: z.string().trim().min(1),
  workstationCount: z.number().int().positive(),
  startingVlan: z.number().int().positive()
});

const deploymentCreateSchema = z.object({
  blueprintId: z.string().uuid(),
  classroomId: z.string().uuid()
});

const parseVlanMaskBits = mask => {
  const match = /^\/(\d{1,2})$/.exec(String(mask || '').trim());
  if (!match) return null;
  const bits = Number(match[1]);
  if (bits < 24 || bits > 30) return null;
  return bits;
};

const isIpLastOctetCompatibleWithMask = (ipLastOctet, mask) => {
  if (ipLastOctet == null) return true;
  const bits = parseVlanMaskBits(mask);
  if (bits == null) return true;
  const subnetSize = 2 ** (32 - bits);
  const offsetInSubnet = ipLastOctet % subnetSize;
  return offsetInSubnet !== 0 && offsetInSubnet !== subnetSize - 1;
};

const validateBlueprintVmIpLastOctets = async payload => {
  const settings = await readPublicTerraformSettings();
  const mask = settings.network_vlan_mask || '/24';
  const invalidVm = payload.vms.find(vm => !isIpLastOctetCompatibleWithMask(vm.ipLastOctet, mask));
  if (invalidVm) {
    throw new Error(`VM "${invalidVm.name}" has an IP last octet incompatible with VLAN mask ${mask}`);
  }
};

const ensureTerraformSettingsFile = async () => {
  try {
    await fs.access(terraformSettingsPath);
  } catch {
    try {
      await fs.copyFile(terraformSettingsSamplePath, terraformSettingsPath);
    } catch {
      await fs.mkdir(settingsDir, { recursive: true });
      await fs.writeFile(terraformSettingsPath, JSON.stringify(defaultTerraformSettings, null, 2));
    }
  }
};

const readTerraformSettings = async () => {
  await ensureTerraformSettingsFile();
  const content = await fs.readFile(terraformSettingsPath, 'utf8');
  return JSON.parse(content);
};

const readPublicTerraformSettings = async () => {
  const settings = await readTerraformSettings();
  return sanitizeSettingsInput(settings);
};

const writeTerraformSettings = async settings => {
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(terraformSettingsPath, JSON.stringify(settings, null, 2));
};

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

const runMigrations = async () => {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const appliedResult = await dbPool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map(row => row.filename));
  const files = (await fs.readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};

const mapTemplate = row => ({
  id: row.id,
  name: row.name,
  description: row.description ?? '',
  osType: row.os_type,
  proxmoxTemplateVmid: row.proxmox_template_vmid,
  fullClone: Boolean(row.full_clone),
  createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
});

const mapBlueprintSummary = row => ({
  id: row.id,
  name: row.name,
  description: row.description ?? '',
  status: row.status,
  vmCount: Number(row.vm_count ?? 0),
  createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
});

const lifecycleStatusFromAction = action => {
  if (['deploy', 'destroy', 'start', 'stop'].includes(action)) return 'queued';
  return 'idle';
};

const sanitizeVmName = input =>
  String(input ?? 'lab-vm')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'lab-vm';

const computeBlueprintBaseVmid = blueprintId => {
  const compact = String(blueprintId).replace(/-/g, '').slice(0, 8);
  const offset = Number.parseInt(compact, 16) % 5000;
  return 10000 + offset * 10;
};

const mapLifecycle = row => ({
  blueprintId: row.blueprint_id,
  status: row.status,
  lastAction: row.last_action,
  lastJobId: row.last_job_id,
  lastRunId: row.last_run_id,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
});

const mapClassroom = row => ({
  id: row.id,
  name: row.name,
  workstationCount: Number(row.workstation_count),
  startingVlan: Number(row.starting_vlan),
  vlans: Array.from({ length: Number(row.workstation_count) }, (_, index) => Number(row.starting_vlan) + index),
  createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
});

const mapDeployment = row => ({
  id: row.id,
  status: row.status,
  lastAction: row.last_action,
  lastJobId: row.last_job_id,
  lastRunId: row.last_run_id,
  createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  blueprint: {
    id: row.blueprint_id,
    name: row.blueprint_name,
    description: row.blueprint_description ?? ''
  },
  classroom: {
    id: row.classroom_id,
    name: row.classroom_name,
    workstationCount: Number(row.workstation_count ?? 0),
    startingVlan: Number(row.starting_vlan ?? 0)
  },
  totalVmCount: Number(row.workstation_count ?? 0) * Number(row.blueprint_vm_count ?? 0)
});

const fetchBlueprintById = async blueprintId => {
  const blueprintResult = await dbPool.query(
    `SELECT
       b.id,
       b.name,
       b.description,
       b.status,
       b.created_at,
       b.updated_at,
       COUNT(v.id) AS vm_count
     FROM lab_blueprints b
     LEFT JOIN lab_blueprint_vms v ON v.blueprint_id = b.id
     WHERE b.id = $1
     GROUP BY b.id`,
    [blueprintId]
  );

  if (!blueprintResult.rowCount) {
    return null;
  }

  const vmResult = await dbPool.query(
    `SELECT
       v.id,
       v.name,
       v.vm_order,
       v.config,
        t.id AS template_id,
        t.name AS template_name,
        t.description AS template_description,
        t.proxmox_template_vmid,
        t.full_clone
      FROM lab_blueprint_vms v
     INNER JOIN vm_templates t ON t.id = v.template_id
     WHERE v.blueprint_id = $1
     ORDER BY v.vm_order ASC, v.created_at ASC`,
    [blueprintId]
  );

  const blueprint = mapBlueprintSummary(blueprintResult.rows[0]);
  return {
    ...blueprint,
    vms: vmResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      order: row.vm_order,
      ipLastOctet: Number.isInteger(row.config?.ipLastOctet) ? row.config.ipLastOctet : null,
      config: row.config ?? {},
      template: {
        id: row.template_id,
        name: row.template_name,
        description: row.template_description ?? '',
        proxmoxTemplateVmid: row.proxmox_template_vmid,
        fullClone: Boolean(row.full_clone)
      }
    }))
  };
};

const upsertLifecycleState = async ({ blueprintId, action, status, jobId = null, runId = null }) => {
  const result = await dbPool.query(
    `INSERT INTO lab_blueprint_lifecycle
      (blueprint_id, status, last_action, last_job_id, last_run_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (blueprint_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       last_action = EXCLUDED.last_action,
       last_job_id = EXCLUDED.last_job_id,
       last_run_id = EXCLUDED.last_run_id,
       updated_at = NOW()
     RETURNING *`,
    [blueprintId, status, action, jobId, runId]
  );
  return mapLifecycle(result.rows[0]);
};

const buildTerraformBlueprintPayload = blueprint => {
  const baseVmid = computeBlueprintBaseVmid(blueprint.id);
  const labName = sanitizeVmName(blueprint.name);
  return {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description ?? '',
    vms: blueprint.vms.map((vm, index) => ({
      id: vm.id,
      name: sanitizeVmName(`${labName}-${vm.name}`),
      vmid: baseVmid + index,
      cloneSource: String(vm.template.proxmoxTemplateVmid),
      fullClone: Boolean(vm.template.fullClone),
      ipLastOctet: vm.ipLastOctet ?? null
    }))
  };
};

const fetchClassroomById = async classroomId => {
  const result = await dbPool.query('SELECT * FROM classrooms WHERE id = $1', [classroomId]);
  if (!result.rowCount) return null;
  return mapClassroom(result.rows[0]);
};

const fetchDeploymentById = async deploymentId => {
  const result = await dbPool.query(
    `SELECT
       d.*,
       b.name AS blueprint_name,
       b.description AS blueprint_description,
       c.name AS classroom_name,
       c.workstation_count,
       c.starting_vlan,
       (
         SELECT COUNT(*)
         FROM lab_blueprint_vms v
         WHERE v.blueprint_id = d.blueprint_id
       ) AS blueprint_vm_count
     FROM lab_deployments d
     INNER JOIN lab_blueprints b ON b.id = d.blueprint_id
     INNER JOIN classrooms c ON c.id = d.classroom_id
     WHERE d.id = $1`,
    [deploymentId]
  );
  if (!result.rowCount) return null;
  return mapDeployment(result.rows[0]);
};

const updateDeploymentState = async ({ deploymentId, action, status, jobId = null, runId = null }) => {
  const result = await dbPool.query(
    `UPDATE lab_deployments
     SET
       status = $2,
       last_action = $3,
       last_job_id = $4,
       last_run_id = $5,
       updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [deploymentId, status, action, jobId, runId]
  );
  if (!result.rowCount) return null;
  return fetchDeploymentById(result.rows[0].id);
};

const buildTerraformDeploymentPayload = ({ deploymentId, blueprint, classroom }) => {
  const baseVmid = computeBlueprintBaseVmid(deploymentId);
  const labName = sanitizeVmName(blueprint.name);
  const vms = [];

  for (let workstationIndex = 0; workstationIndex < classroom.workstationCount; workstationIndex += 1) {
    const workstationNumber = String(workstationIndex + 1).padStart(2, '0');
    const vlanTag = classroom.startingVlan + workstationIndex;

    for (const vm of blueprint.vms) {
      vms.push({
        id: `${workstationNumber}-${vm.id}`,
        name: sanitizeVmName(`${labName}-${workstationNumber}-${vm.name}`),
        vmid: baseVmid + vms.length,
        cloneSource: String(vm.template.proxmoxTemplateVmid),
        fullClone: Boolean(vm.template.fullClone),
        ipLastOctet: vm.ipLastOctet ?? null,
        vlanTag
      });
    }
  }

  return {
    id: deploymentId,
    name: blueprint.name,
    classroomName: classroom.name,
    description: blueprint.description ?? '',
    vms
  };
};

const fetchDeploymentRows = async () => {
  const result = await dbPool.query(
    `SELECT
       d.*,
       b.name AS blueprint_name,
       b.description AS blueprint_description,
       c.name AS classroom_name,
       c.workstation_count,
       c.starting_vlan,
       (
         SELECT COUNT(*)
         FROM lab_blueprint_vms v
         WHERE v.blueprint_id = d.blueprint_id
       ) AS blueprint_vm_count
     FROM lab_deployments d
     INNER JOIN lab_blueprints b ON b.id = d.blueprint_id
     INNER JOIN classrooms c ON c.id = d.classroom_id
     ORDER BY LOWER(b.name) ASC, LOWER(c.name) ASC, d.created_at ASC`
  );
  return result.rows;
};

const deriveDeploymentStatusFromResources = (currentStatus, expectedVmids, resourceByVmid) => {
  const states = expectedVmids
    .map(vmid => resourceByVmid.get(Number(vmid))?.status ?? null)
    .filter(Boolean);

  if (!states.length) {
    if (['idle', 'failed', 'destroyed'].includes(currentStatus)) {
      return currentStatus;
    }
    return 'destroyed';
  }

  const allRunning = states.length === expectedVmids.length && states.every(state => state === 'running');
  if (allRunning) return 'running';

  const allStopped = states.length === expectedVmids.length && states.every(state => state === 'stopped');
  if (allStopped) return 'stopped';

  return 'mixed';
};

const persistBlueprint = async (blueprintId, payload) => {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO lab_blueprints (id, name, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (id)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [blueprintId, payload.name, payload.description, payload.status]
    );

    await client.query('DELETE FROM lab_blueprint_vms WHERE blueprint_id = $1', [blueprintId]);

    for (const [index, vm] of payload.vms.entries()) {
      const config = {
        ...(vm.config ?? {}),
        ...(vm.ipLastOctet == null ? {} : { ipLastOctet: vm.ipLastOctet })
      };
      await client.query(
        `INSERT INTO lab_blueprint_vms
          (id, blueprint_id, template_id, name, vm_order, config, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [vm.id ?? uuidv4(), blueprintId, vm.templateId, vm.name, index, config]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return fetchBlueprintById(blueprintId);
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get(
  '/api/classrooms',
  wrapAsync(async (req, res) => {
    const result = await dbPool.query('SELECT * FROM classrooms ORDER BY name ASC');
    res.json(result.rows.map(mapClassroom));
  })
);

app.post(
  '/api/classrooms',
  wrapAsync(async (req, res) => {
    const parsed = classroomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await dbPool.query(
      `INSERT INTO classrooms
        (id, name, workstation_count, starting_vlan, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [uuidv4(), parsed.data.name, parsed.data.workstationCount, parsed.data.startingVlan]
    );

    res.status(201).json(mapClassroom(result.rows[0]));
  })
);

app.delete(
  '/api/classrooms/:id',
  wrapAsync(async (req, res) => {
    const result = await dbPool.query('DELETE FROM classrooms WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rowCount) {
      res.status(404).json({ error: 'classroom not found' });
      return;
    }
    res.json({ ok: true, id: result.rows[0].id });
  })
);

app.get(
  '/api/lifecycle/deployments',
  wrapAsync(async (req, res) => {
    const rows = await fetchDeploymentRows();
    res.json(rows.map(mapDeployment));
  })
);

app.post(
  '/api/lifecycle/deployments/refresh-state',
  wrapAsync(async (req, res) => {
    const envSettings = readTerraformEnvSettings();
    assertRequiredTerraformEnvSettings(envSettings);

    const payload = await requestJson({
      url: new URL('cluster/resources?type=vm', `${envSettings.proxmox_api_url.replace(/\/+$/, '')}/`),
      method: 'GET',
      ...proxmoxRequestOptions(envSettings)
    });

    const resources = Array.isArray(payload?.data) ? payload.data : [];
    const resourceByVmid = new Map(resources.map(resource => [Number(resource.vmid), resource]));
    const rows = await fetchDeploymentRows();
    const refreshed = [];

    for (const row of rows) {
      const deployment = mapDeployment(row);
      const blueprint = await fetchBlueprintById(deployment.blueprint.id);
      const classroom = await fetchClassroomById(deployment.classroom.id);
      const vmids = buildTerraformDeploymentPayload({
        deploymentId: deployment.id,
        blueprint,
        classroom
      }).vms.map(vm => vm.vmid);

      const reconciledStatus = deriveDeploymentStatusFromResources(
        deployment.status,
        vmids,
        resourceByVmid
      );

      await dbPool.query(
        `UPDATE lab_deployments
         SET status = $2, last_action = 'refresh', updated_at = NOW()
         WHERE id = $1`,
        [deployment.id, reconciledStatus]
      );

      const next = await fetchDeploymentById(deployment.id);
      if (next) {
        refreshed.push(next);
      }
    }

    res.json({ ok: true, deployments: refreshed });
  })
);

app.post(
  '/api/lifecycle/deployments',
  wrapAsync(async (req, res) => {
    const parsed = deploymentCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    const blueprint = await fetchBlueprintById(parsed.data.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: 'blueprint not found' });
      return;
    }

    const classroom = await fetchClassroomById(parsed.data.classroomId);
    if (!classroom) {
      res.status(404).json({ error: 'classroom not found' });
      return;
    }

    const deploymentInsert = await dbPool.query(
      `INSERT INTO lab_deployments
        (id, blueprint_id, classroom_id, status, last_action, created_at, updated_at)
       VALUES ($1, $2, $3, 'idle', 'prepare', NOW(), NOW())
       RETURNING id`,
      [uuidv4(), blueprint.id, classroom.id]
    );

    const deploymentId = deploymentInsert.rows[0].id;
    const deployment = await fetchDeploymentById(deploymentId);

    res.status(201).json({
      ok: true,
      deployment
    });
  })
);

app.post(
  '/api/lifecycle/deployments/:id/:action',
  wrapAsync(async (req, res) => {
    const action = req.params.action;
    if (!['deploy', 'start', 'stop', 'destroy'].includes(action)) {
      res.status(400).json({ error: 'invalid deployment lifecycle action' });
      return;
    }

    const deployment = await fetchDeploymentById(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'deployment not found' });
      return;
    }

    const blueprint = await fetchBlueprintById(deployment.blueprint.id);
    const classroom = await fetchClassroomById(deployment.classroom.id);
    const runId = `deployment-${deployment.id}-${Date.now()}`;
    const jobName =
      action === 'deploy'
        ? 'apply'
        : action === 'destroy'
          ? 'destroy'
          : action;
    const job = await queues.terraform.add(
      jobName,
      {
        action,
        labInstanceId: deployment.id,
        runId,
        deploymentId: deployment.id,
        blueprint: buildTerraformDeploymentPayload({ deploymentId: deployment.id, blueprint, classroom })
      },
      {
        attempts: 1,
        ...queueRetention
      }
    );

    const updated = await updateDeploymentState({
      deploymentId: deployment.id,
      action,
      status: 'queued',
      jobId: String(job.id),
      runId
    });

    res.json({
      ok: true,
      deployment: updated,
      jobId: job.id,
      runId
    });
  })
);

app.delete(
  '/api/lifecycle/deployments/:id',
  wrapAsync(async (req, res) => {
    const deployment = await fetchDeploymentById(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'deployment not found' });
      return;
    }

    if (!['idle', 'failed', 'destroyed'].includes(deployment.status)) {
      res.status(409).json({ error: 'deployment can only be deleted when it is not deployed' });
      return;
    }

    const result = await dbPool.query('DELETE FROM lab_deployments WHERE id = $1 RETURNING id', [req.params.id]);
    res.json({ ok: true, id: result.rows[0].id });
  })
);

app.get(
  '/api/templates',
  wrapAsync(async (req, res) => {
    const result = await dbPool.query('SELECT * FROM vm_templates ORDER BY name ASC');
    res.json(result.rows.map(mapTemplate));
  })
);

app.post(
  '/api/templates',
  wrapAsync(async (req, res) => {
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    const id = uuidv4();
    const result = await dbPool.query(
      `INSERT INTO vm_templates
        (id, name, description, os_type, proxmox_template_vmid, full_clone, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [
        id,
        parsed.data.name,
        parsed.data.description,
        parsed.data.osType,
        parsed.data.proxmoxTemplateVmid,
        parsed.data.fullClone
      ]
    );

    res.status(201).json(mapTemplate(result.rows[0]));
  })
);

app.delete(
  '/api/templates/:id',
  wrapAsync(async (req, res) => {
    try {
      const result = await dbPool.query('DELETE FROM vm_templates WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.rowCount) {
        res.status(404).json({ error: 'vm model not found' });
        return;
      }
      res.json({ ok: true, id: result.rows[0].id });
    } catch (error) {
      if (error?.code === '23503') {
        res.status(409).json({ error: 'vm model is used by an existing blueprint' });
        return;
      }
      throw error;
    }
  })
);

app.get(
  '/api/blueprints',
  wrapAsync(async (req, res) => {
    const result = await dbPool.query(
      `SELECT
         b.id,
         b.name,
         b.description,
         b.status,
         b.created_at,
         b.updated_at,
         COUNT(v.id) AS vm_count
       FROM lab_blueprints b
       LEFT JOIN lab_blueprint_vms v ON v.blueprint_id = b.id
       GROUP BY b.id
       ORDER BY b.updated_at DESC, b.name ASC`
    );
    res.json(result.rows.map(mapBlueprintSummary));
  })
);

app.get(
  '/api/blueprints/:id',
  wrapAsync(async (req, res) => {
    const blueprint = await fetchBlueprintById(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: 'blueprint not found' });
      return;
    }
    res.json(blueprint);
  })
);

app.post(
  '/api/blueprints',
  wrapAsync(async (req, res) => {
    const parsed = blueprintSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    await validateBlueprintVmIpLastOctets(parsed.data);
    const blueprint = await persistBlueprint(uuidv4(), parsed.data);
    res.status(201).json(blueprint);
  })
);

app.put(
  '/api/blueprints/:id',
  wrapAsync(async (req, res) => {
    const parsed = blueprintSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
      return;
    }

    await validateBlueprintVmIpLastOctets(parsed.data);
    const existing = await fetchBlueprintById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'blueprint not found' });
      return;
    }

    const blueprint = await persistBlueprint(req.params.id, parsed.data);
    res.json(blueprint);
  })
);

app.delete(
  '/api/blueprints/:id',
  wrapAsync(async (req, res) => {
    const result = await dbPool.query('DELETE FROM lab_blueprints WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rowCount) {
      res.status(404).json({ error: 'blueprint not found' });
      return;
    }
    res.json({ ok: true, id: result.rows[0].id });
  })
);

app.get(
  '/api/lifecycle/labs',
  wrapAsync(async (req, res) => {
    const result = await dbPool.query(
      `SELECT
         b.id,
         b.name,
         b.description,
         b.updated_at,
         COUNT(v.id) AS vm_count,
         l.status AS lifecycle_status,
         l.last_action,
         l.last_job_id,
         l.last_run_id,
         l.updated_at AS lifecycle_updated_at
       FROM lab_blueprints b
       LEFT JOIN lab_blueprint_vms v ON v.blueprint_id = b.id
       LEFT JOIN lab_blueprint_lifecycle l ON l.blueprint_id = b.id
       GROUP BY
         b.id,
         b.name,
         b.description,
         b.updated_at,
         l.status,
         l.last_action,
         l.last_job_id,
         l.last_run_id,
         l.updated_at
       ORDER BY b.updated_at DESC, b.name ASC`
    );

    res.json(
      result.rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        vmCount: Number(row.vm_count ?? 0),
        updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
        lifecycle: {
          status: row.lifecycle_status ?? 'idle',
          lastAction: row.last_action ?? null,
          lastJobId: row.last_job_id ?? null,
          lastRunId: row.last_run_id ?? null,
          updatedAt: row.lifecycle_updated_at?.toISOString?.() ?? row.lifecycle_updated_at ?? null
        }
      }))
    );
  })
);

app.post(
  '/api/lifecycle/labs/:id/:action',
  wrapAsync(async (req, res) => {
    const action = req.params.action;
    if (!['deploy', 'destroy', 'start', 'stop'].includes(action)) {
      res.status(400).json({ error: 'invalid lifecycle action' });
      return;
    }

    const blueprint = await fetchBlueprintById(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: 'blueprint not found' });
      return;
    }

    const runId = `blueprint-${blueprint.id}-${Date.now()}`;
    const jobName =
      action === 'deploy'
        ? 'apply'
        : action === 'destroy'
          ? 'destroy'
          : action;
    const job = await queues.terraform.add(
      jobName,
      {
        action,
        labInstanceId: blueprint.id,
        runId,
        blueprint: buildTerraformBlueprintPayload(blueprint)
      },
      {
        attempts: 1,
        ...queueRetention
      }
    );

    let lifecycle = null;
    try {
      lifecycle = await upsertLifecycleState({
        blueprintId: blueprint.id,
        action,
        status: lifecycleStatusFromAction(action),
        jobId: String(job.id),
        runId
      });
    } catch (error) {
      console.error('Unable to persist lifecycle state after queueing job', error);
    }

    res.json({
      ok: true,
      action,
      blueprintId: blueprint.id,
      jobId: job.id,
      runId,
      lifecycle
    });
  })
);

app.get('/api/queues', async (req, res) => {
  try {
    const payload = [];
    for (const [name, queue] of Object.entries(queues)) {
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      payload.push({ name, ...counts });
    }
    res.json(payload);
  } catch (err) {
    console.error('Unable to fetch queues', err);
    res.status(500).json({ error: 'unable to fetch queue stats' });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const payload = [];
    for (const [name, queue] of Object.entries(queues)) {
      const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'completed', 'failed'], 0, 49, true);
      for (const job of jobs) {
        const state = await job.getState();
        const createdAt = job.timestamp ? new Date(job.timestamp).toISOString() : null;
        const startedAt = job.processedOn ? new Date(job.processedOn).toISOString() : null;
        const finishedAt = job.finishedOn ? new Date(job.finishedOn).toISOString() : null;
        const durationMs =
          job.processedOn && job.finishedOn
            ? Math.max(0, job.finishedOn - job.processedOn)
            : job.processedOn
              ? Math.max(0, Date.now() - job.processedOn)
              : null;
        const blueprint = job.data?.blueprint ?? null;
        const associatedLab =
          blueprint?.name && blueprint?.classroomName
            ? `${blueprint.name} @ ${blueprint.classroomName}`
            : blueprint?.name ?? job.data?.labInstanceId ?? 'n/a';

        payload.push({
          id: String(job.id),
          queue: queue.name,
          queueKey: name,
          name: job.name,
          state,
          action: job.data?.action ?? job.name,
          associatedLab,
          runId: job.data?.runId ?? null,
          createdAt,
          startedAt,
          finishedAt,
          durationMs,
          attemptsMade: job.attemptsMade ?? 0,
          failedReason: job.failedReason ?? null
        });
      }
    }

    payload.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
    res.json(payload);
  } catch (err) {
    console.error('Unable to fetch jobs', err);
    res.status(500).json({ error: 'unable to fetch jobs' });
  }
});

app.post('/api/jobs/clear-history', async (req, res) => {
  try {
    const summary = {};
    for (const [name, queue] of Object.entries(queues)) {
      let removed = 0;
      for (const status of ['completed', 'failed']) {
        while (true) {
          const deleted = await queue.clean(0, 1000, status);
          removed += deleted.length;
          if (!deleted.length) break;
        }
      }
      summary[name] = removed;
    }

    res.json({ ok: true, removed: summary });
  } catch (err) {
    console.error('Unable to clear job history', err);
    res.status(500).json({ error: 'unable to clear job history' });
  }
});

app.get('/api/workers', async (req, res) => {
  try {
    const workers = [];
    for (const workerName of Object.keys(queueNames)) {
      const state = await redisClient.hGetAll(`worker:${workerName}`);
      workers.push({
        name: workerName,
        status: state.status || 'unknown',
        lastHeartbeat: state.lastHeartbeat ? new Date(Number(state.lastHeartbeat)).toISOString() : null
      });
    }
    res.json(workers);
  } catch (err) {
    console.error('Unable to fetch workers', err);
    res.status(500).json({ error: 'unable to fetch worker statuses' });
  }
});

app.get('/api/settings/terraform', async (req, res) => {
  try {
    const settings = await readPublicTerraformSettings();
    res.json(settings);
  } catch (err) {
    console.error('Unable to fetch terraform settings', err);
    res.status(500).json({ error: 'unable to load terraform settings' });
  }
});

app.post('/api/settings/terraform', async (req, res) => {
  try {
    const sanitized = sanitizeSettingsInput(req.body);
    if (!Object.keys(sanitized).length) {
      return res.status(400).json({ error: 'no valid settings provided' });
    }
    const existing = await readPublicTerraformSettings();
    const updated = { ...defaultTerraformSettings, ...existing, ...sanitized };
    await writeTerraformSettings(updated);
    res.json(updated);
  } catch (err) {
    console.error('Unable to persist terraform settings', err);
    res.status(400).json({ error: err.message ?? 'unable to persist terraform settings' });
  }
});

app.post('/api/control', async (req, res) => {
  const { worker, action } = req.body;
  if (!queueNames[worker] || !['pause', 'resume'].includes(action)) {
    return res.status(400).json({ error: 'invalid worker or action' });
  }

  try {
    await redisClient.publish(`control:${worker}`, action);
    res.json({ ok: true, worker, action });
  } catch (err) {
    console.error('Control command failed', err);
    res.status(500).json({ error: 'failed to publish control command' });
  }
});

app.post('/api/jobs/terraform', async (req, res) => {
  try {
    const job = await queues.terraform.add(
      'apply',
      {
        labInstanceId: req.body.labInstanceId ?? 'lab-dashboard',
        runId: `dashboard-${Date.now()}`
      },
      {
        attempts: 1,
        ...queueRetention
      }
    );

    res.json({
      status: 'queued',
      queue: 'terraform-workflows',
      jobId: job.id
    });
  } catch (err) {
    console.error('Failed to queue terraform job', err);
    res.status(500).json({ error: 'failed to queue terraform job' });
  }
});

let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await Promise.all(Object.values(queues).map(queue => queue.close()));
  if (redisClient.isOpen) {
    await redisClient.disconnect();
  }
  await dbPool.end();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  await ensureTerraformSettingsFile();
  await runMigrations();
  await redisClient.connect();
  app.listen(port, () => {
    console.log(`Dashboard listening on http://localhost:${port}`);
  });
})().catch(err => {
  console.error('Failed to start dashboard', err);
  process.exit(1);
});
