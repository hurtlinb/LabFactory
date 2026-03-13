import 'dotenv/config';
import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createClient } from 'redis';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { redisConnectionOptions } from '../config/redis.js';
import { sanitizeSettingsInput, defaultTerraformSettings } from '../lib/terraformSettings.js';

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
  proxmoxTemplateVmid: z.number().int().positive(),
  fullClone: z.boolean().optional().default(false),
});

const blueprintVmSchema = z.object({
  id: z.string().uuid().optional(),
  templateId: z.string().uuid(),
  name: z.string().trim().min(1),
  config: z.record(z.string(), z.unknown()).optional().default({})
});

const blueprintSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional().default(''),
  status: z.enum(['draft', 'ready', 'archived']).optional().default('draft'),
  vms: z.array(blueprintVmSchema).min(1)
});

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
      fullClone: Boolean(vm.template.fullClone)
    }))
  };
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
      await client.query(
        `INSERT INTO lab_blueprint_vms
          (id, blueprint_id, template_id, name, vm_order, config, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [vm.id ?? uuidv4(), blueprintId, vm.templateId, vm.name, index, vm.config ?? {}]
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
        (id, name, description, proxmox_template_vmid, full_clone, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING *`,
      [
        id,
        parsed.data.name,
        parsed.data.description,
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
