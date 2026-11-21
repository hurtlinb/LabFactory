import { z } from 'zod';
import { transitionPoolVm } from './states.js';
import { cancelPoolRequest } from './reservation.js';
import { cancelPoolRequestVerified } from './cancellation.js';
import { LEASE_CATEGORIES } from './leases.js';
import { isWindowsOsType } from './config.js';
import { TERRAFORM_LAB_VMID_RANGE } from '../vmidAvailability.js';
import { BUSY_LAB_STATUSES } from './manager.js';

// Windows pool administration (lot P6): overview, configuration, activation (from the VM
// Models page since 2026-11-21, no more qualification), suspension, limits, quarantine,
// timelines, metrics. Called by the dashboard routes.

export class PoolAdminError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const proxmoxName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

const settingsSchema = z.object({
  paused: z.boolean().optional(),
  proxmoxPool: proxmoxName.nullable().optional(),
  dnsServers: z.array(z.string().regex(IPV4)).min(1).max(4).optional(),
  // Dedicated VMID range (dev 70000-79999, prod 80000-89999: same Proxmox cluster).
  vmidMin: z.number().int().min(100).max(999_999_999).optional(),
  vmidMax: z.number().int().min(100).max(999_999_999).optional(),
  // Global ceiling: stock VMs (in preparation + ready) of all the templates together.
  maxCapacity: z.number().int().min(1).max(2000).optional()
}).strict().refine(value => (value.vmidMin === undefined) === (value.vmidMax === undefined),
  { message: 'vmidMin and vmidMax go together', path: ['vmidMin'] });

const MIN_VMID_RANGE_SIZE = 100;

// Technical settings of a template (Windows pool page). Activation and ready reserve: VM Models
// page (setTemplatePool). Source template: the Proxmox VMID of the VM model (syncTemplateSource).
const templateSchema = z.object({
  maxParallelPreparations: z.number().int().min(1).max(32),
  // Empty / null = automatic placement (node with the fewest preparations, then the most free memory).
  node: z.union([proxmoxName, z.literal(''), z.null()]).optional().transform(value => value || null),
  storage: proxmoxName,
  preparationTimeoutSeconds: z.number().int().min(300).max(7200).optional(),
  assignmentTimeoutSeconds: z.number().int().min(60).max(3600).optional()
}).strict();

const activationSchema = z.object({
  enabled: z.boolean(),
  readyTarget: z.number().int().min(0).max(500),
  // Storage of the Proxmox template disk (linked clones live there), used on the first activation.
  storage: proxmoxName.optional()
}).strict();

const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new PoolAdminError('VALIDATION', result.error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; '));
  return result.data;
};

// --- Overview --------------------------------------------------------------------------

export async function getPoolOverview(db) {
  const settings = (await db.query('SELECT * FROM windows_pool_settings WHERE id')).rows[0] ?? null;
  // p.* FIRST: its template_id (NULL for an unconfigured template, LEFT JOIN) must never overwrite
  // t.id — the last column with the same name wins in the row object (bug seen in dev: id null ->
  // PUT .../templates/null).
  const templates = (await db.query(
    `SELECT p.*, t.id AS template_id, t.name, t.os_type, t.language, t.proxmox_template_vmid
       FROM vm_templates t LEFT JOIN windows_pool_templates p ON p.template_id = t.id
      ORDER BY t.name`)).rows.filter(row => isWindowsOsType(row.os_type));
  const counts = new Map();
  for (const row of (await db.query(
    `SELECT template_id, state, COUNT(*)::int AS n FROM windows_pool_vms WHERE state <> 'deleted' GROUP BY 1, 2`)).rows) {
    counts.set(row.template_id, { ...(counts.get(row.template_id) ?? {}), [row.state]: row.n });
  }
  const readyByTemplate = new Map([...counts].map(([id, c]) => [id, c.ready ?? 0]));
  const requests = (await db.query(
    `SELECT r.id, r.deployment_id, r.kind, r.status, r.demand, r.blocked_reason, r.created_at, r.reserved_at,
            d.status AS deployment_status, d.deployment_number, b.name AS blueprint_name, c.name AS classroom_name
       FROM windows_pool_requests r
       JOIN lab_deployments d ON d.id = r.deployment_id
       LEFT JOIN lab_blueprints b ON b.id = d.blueprint_id
       LEFT JOIN classrooms c ON c.id = d.classroom_id
      WHERE r.status IN ('waiting_for_pool', 'reserved')
      ORDER BY r.created_at, r.id`)).rows.map(row => ({
    id: row.id,
    deploymentId: row.deployment_id,
    deploymentNumber: row.deployment_number == null ? null : Number(row.deployment_number),
    blueprintName: row.blueprint_name ?? null,
    classroomName: row.classroom_name ?? null,
    deploymentStatus: row.deployment_status,
    kind: row.kind,
    status: row.status,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    reservedAt: row.reserved_at,
    // Missing needs (waiting): demand per template vs VMs ready right now.
    demand: (row.demand ?? []).map(item => ({
      templateId: item.templateId,
      count: item.count,
      readyNow: readyByTemplate.get(item.templateId) ?? 0,
      missing: row.status === 'waiting_for_pool' ? Math.max(0, item.count - (readyByTemplate.get(item.templateId) ?? 0)) : 0
    }))
  }));
  const limits = (await db.query(
    `SELECT l.category, l.scope, l.max_active,
            (SELECT COUNT(*)::int FROM windows_pool_operation_leases x WHERE x.category = l.category AND x.scope = l.scope) AS active,
            (SELECT COUNT(*)::int FROM windows_pool_operation_leases x WHERE x.category = l.category AND x.scope = l.scope AND x.proxmox_upid IS NOT NULL) AS with_task
       FROM windows_pool_operation_limits l ORDER BY l.category, l.scope`)).rows
    .map(row => ({ category: row.category, scope: row.scope, maxActive: row.max_active, active: row.active, withProxmoxTask: row.with_task }));
  const quarantined = (await db.query(
    `SELECT v.id, v.vmid, v.node, v.template_id, v.revision, v.error_code, v.last_error, v.state_changed_at
       FROM windows_pool_vms v WHERE v.state = 'quarantined' ORDER BY v.state_changed_at DESC`)).rows
    .map(row => ({ id: row.id, vmid: row.vmid, node: row.node, templateId: row.template_id, revision: row.revision,
      errorCode: row.error_code, lastError: row.last_error, since: row.state_changed_at }));
  // Labs in progress: the manager does not refill the reserve meanwhile (same rule, 3 h max).
  let busyLabs = 0;
  try {
    busyLabs = (await db.query(
      `SELECT COUNT(*)::int AS n FROM lab_deployments WHERE status = ANY($1::text[]) AND updated_at > NOW() - interval '3 hours'`,
      [BUSY_LAB_STATUSES])).rows[0].n;
  } catch (error) { if (!['42P01', '42703'].includes(error?.code)) throw error; }
  return {
    busyLabs,
    settings: settings && {
      cluster: settings.cluster, paused: settings.paused, proxmoxPool: settings.proxmox_pool,
      dnsServers: settings.dns_servers, vmidMin: settings.vmid_min, vmidMax: settings.vmid_max,
      maxCapacity: settings.max_capacity
    },
    templates: templates.map(row => {
      const c = counts.get(row.template_id) ?? {};
      return {
        templateId: row.template_id,
        name: row.name,
        osType: row.os_type,
        language: row.language,
        proxmoxTemplateVmid: row.proxmox_template_vmid,
        configured: row.ready_target != null,
        config: row.ready_target == null ? null : {
          enabled: row.enabled, readyTarget: row.ready_target,
          maxParallelPreparations: row.max_parallel_preparations, node: row.node, storage: row.storage,
          revision: row.revision, sourceTemplateVmid: row.source_template_vmid,
          preparationTimeoutSeconds: row.preparation_timeout_seconds, assignmentTimeoutSeconds: row.assignment_timeout_seconds
        },
        counts: {
          ready: c.ready ?? 0,
          preparing: (c.creating ?? 0) + (c.preparing ?? 0),
          reserved: (c.reserved ?? 0) + (c.configuring ?? 0),
          assigned: c.assigned ?? 0,
          quarantined: c.quarantined ?? 0,
          deleting: c.deleting ?? 0
        }
      };
    }),
    requests,
    limits,
    quarantined,
    metrics: await getPoolMetrics(db)
  };
}

// Durations measured separately (last N days): preparation (boot -> ready), pool wait
// (request -> reservation, split: immediate stock / waiting), network assignment (configuring -> assigned).
export async function getPoolMetrics(db, { days = 7 } = {}) {
  const stats = async sql => (await db.query(sql, [days])).rows[0];
  const summarize = row => ({
    count: Number(row?.n ?? 0),
    p50Seconds: row?.p50 == null ? null : Math.round(Number(row.p50)),
    p90Seconds: row?.p90 == null ? null : Math.round(Number(row.p90)),
    maxSeconds: row?.max == null ? null : Math.round(Number(row.max))
  });
  const percentiles = expr => `COUNT(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expr}) AS p50,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY ${expr}) AS p90, MAX(${expr}) AS max`;
  const preparation = await stats(`SELECT ${percentiles(`(detail->>'preparationMs')::numeric / 1000`)}
     FROM windows_pool_vm_events WHERE to_state = 'ready' AND detail ? 'preparationMs' AND created_at > NOW() - make_interval(days => $1)`);
  const waitExpr = 'EXTRACT(EPOCH FROM reserved_at - created_at)';
  const waitAll = await stats(`SELECT ${percentiles(waitExpr)} FROM windows_pool_requests
     WHERE reserved_at IS NOT NULL AND created_at > NOW() - make_interval(days => $1)`);
  const waitDelayed = await stats(`SELECT ${percentiles(waitExpr)} FROM windows_pool_requests
     WHERE reserved_at IS NOT NULL AND reserved_at - created_at > interval '10 seconds' AND created_at > NOW() - make_interval(days => $1)`);
  const assignment = await stats(`WITH pairs AS (
       SELECT c.pool_vm_id, EXTRACT(EPOCH FROM a.created_at - c.created_at) AS seconds
         FROM windows_pool_vm_events c
         JOIN windows_pool_vm_events a ON a.pool_vm_id = c.pool_vm_id AND a.to_state = 'assigned' AND a.id > c.id
        WHERE c.to_state = 'configuring' AND c.created_at > NOW() - make_interval(days => $1))
     SELECT ${percentiles('seconds')} FROM pairs`);
  return {
    days,
    preparation: summarize(preparation),
    poolWait: summarize(waitAll),
    // Requests that really waited (empty or insufficient stock): never mixed up with the immediate reservations.
    poolWaitWhenStockEmpty: summarize(waitDelayed),
    assignment: summarize(assignment)
  };
}

export async function getVmTimeline(db, poolVmId) {
  const vm = (await db.query('SELECT id, vmid, node, template_id, revision, state, error_code, last_error, created_at FROM windows_pool_vms WHERE id = $1', [poolVmId])).rows[0];
  if (!vm) throw new PoolAdminError('NOT_FOUND', 'Unknown pool VM', 404);
  const events = (await db.query(
    'SELECT from_state, to_state, detail, created_at FROM windows_pool_vm_events WHERE pool_vm_id = $1 ORDER BY id', [poolVmId])).rows;
  return { vm, events: events.map(e => ({ from: e.from_state, to: e.to_state, detail: e.detail, at: e.created_at })) };
}

// --- Configuration -------------------------------------------------------------------------

export async function updatePoolSettings(db, input) {
  const value = parse(settingsSchema, input);
  const sets = [];
  const params = [];
  if (value.paused !== undefined) { params.push(value.paused); sets.push(`paused = $${params.length}`); }
  if (value.proxmoxPool !== undefined) { params.push(value.proxmoxPool); sets.push(`proxmox_pool = $${params.length}`); }
  if (value.dnsServers !== undefined) { params.push(value.dnsServers); sets.push(`dns_servers = $${params.length}::text[]`); }
  if (value.maxCapacity !== undefined) { params.push(value.maxCapacity); sets.push(`max_capacity = $${params.length}`); }
  const current = (await db.query('SELECT vmid_min, vmid_max FROM windows_pool_settings WHERE id')).rows[0];
  const rangeChanged = value.vmidMin !== undefined && current &&
    (Number(current.vmid_min) !== value.vmidMin || Number(current.vmid_max) !== value.vmidMax);
  if (rangeChanged) {
    checkVmidRange(value.vmidMin, value.vmidMax);
    params.push(value.vmidMin, value.vmidMax);
    sets.push(`vmid_min = $${params.length - 1}`, `vmid_max = $${params.length}`);
  }
  if (!sets.length) throw new PoolAdminError('VALIDATION', 'Nothing to change');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const settings = (await client.query('SELECT vmid_min, vmid_max FROM windows_pool_settings WHERE id FOR UPDATE')).rows[0];
    if (rangeChanged) {
      // Pool VMs (stock, labs, quarantine) and active assignments must stay inside the range:
      // their VMIDs would otherwise lose the Terraform protection of the range.
      const outside = (await client.query(
        `SELECT vmid FROM windows_pool_vms WHERE state <> 'deleted' AND (vmid < $1 OR vmid > $2)
         UNION SELECT vmid FROM lab_vm_assignments WHERE status = 'active' AND (vmid < $1 OR vmid > $2)
         ORDER BY 1 LIMIT 5`, [value.vmidMin, value.vmidMax])).rows.map(row => row.vmid);
      if (outside.length) {
        throw new PoolAdminError('VMID_RANGE_IN_USE',
          `VMIDs ${outside.join(', ')} of the pool fall outside ${value.vmidMin}-${value.vmidMax} (range ${settings.vmid_min}-${settings.vmid_max}): empty the stock and destroy the labs using them first`, 409);
      }
    }
    await client.query(`UPDATE windows_pool_settings SET ${sets.join(', ')}, version = version + 1, updated_at = NOW() WHERE id`, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function checkVmidRange(min, max) {
  if (max - min + 1 < MIN_VMID_RANGE_SIZE) {
    throw new PoolAdminError('VALIDATION', `The VMID range must hold at least ${MIN_VMID_RANGE_SIZE} VMIDs`);
  }
  if (min <= TERRAFORM_LAB_VMID_RANGE.max && max >= TERRAFORM_LAB_VMID_RANGE.min) {
    throw new PoolAdminError('VALIDATION',
      `The VMID range overlaps the Terraform labs (${TERRAFORM_LAB_VMID_RANGE.min}-${TERRAFORM_LAB_VMID_RANGE.max})`);
  }
}

// Technical settings of a template (node, storage, parallel preparations, timeouts). Creates the
// configuration (disabled) if needed; the source template is the VMID of the VM model.
export async function configureTemplate(db, templateId, input) {
  const value = parse(templateSchema, input);
  const template = await windowsTemplate(db, templateId);
  const result = await db.query(
    `INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage,
       source_template_vmid, preparation_timeout_seconds, assignment_timeout_seconds)
     VALUES ($1, false, 0, 1, $2, $3, $4, $5, COALESCE($6, 1800), COALESCE($7, 900))
     ON CONFLICT (template_id) DO UPDATE SET max_parallel_preparations = $2, node = $3, storage = $4,
       preparation_timeout_seconds = COALESCE($6, windows_pool_templates.preparation_timeout_seconds),
       assignment_timeout_seconds = COALESCE($7, windows_pool_templates.assignment_timeout_seconds),
       version = windows_pool_templates.version + 1, updated_at = NOW()
     RETURNING (xmax = 0) AS created`,
    [templateId, value.maxParallelPreparations, value.node, value.storage, template.proxmox_template_vmid,
      value.preparationTimeoutSeconds ?? null, value.assignmentTimeoutSeconds ?? null]);
  return { created: result.rows[0].created };
}

// Activation from the VM Models page (user decision 2026-11-21): Enable/Disable + number of ready
// VMs. First activation without a configuration: created with automatic placement, the storage of
// the Proxmox template disk (given by the caller) and 2 parallel preparations. Disabling destroys
// the stock (ready and in preparation); VMs already in labs are never touched.
export async function setTemplatePool(db, templateId, input) {
  const value = parse(activationSchema, input);
  const template = await windowsTemplate(db, templateId);
  const existing = (await db.query('SELECT storage FROM windows_pool_templates WHERE template_id = $1', [templateId])).rows[0];
  if (!existing) {
    if (!value.enabled) return { created: false };
    if (!value.storage) throw new PoolAdminError('NO_PLACEMENT', 'Storage of the Proxmox template unknown: configure it on the Windows pool page', 409);
    await db.query(
      `INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
       VALUES ($1, true, $2, 1, 2, NULL, $3, $4)`, [templateId, value.readyTarget, value.storage, template.proxmox_template_vmid]);
    return { created: true };
  }
  await db.query(
    `UPDATE windows_pool_templates SET enabled = $2, ready_target = $3, storage = COALESCE(storage, $4),
            version = version + 1, updated_at = NOW() WHERE template_id = $1`,
    [templateId, value.enabled, value.readyTarget, value.storage ?? null]);
  return { created: false };
}

// The pool follows the Proxmox VMID of the VM model: another VMID = new revision (linked clones of
// the old template drained: ready VMs destroyed, VMs in labs untouched). The template stays enabled.
export async function syncTemplateSource(db, templateId, proxmoxTemplateVmid) {
  const result = await db.query(
    `UPDATE windows_pool_templates SET source_template_vmid = $2, revision = revision + 1, version = version + 1, updated_at = NOW()
      WHERE template_id = $1 AND source_template_vmid <> $2 RETURNING revision`, [templateId, Number(proxmoxTemplateVmid)]);
  return { newRevision: result.rowCount ? result.rows[0].revision : null };
}

// After an edit of the VM model: the pool follows its Proxmox VMID (new revision) and is disabled
// if the model is no longer a Windows one.
export async function syncTemplateModel(db, templateId, { osType, proxmoxTemplateVmid }) {
  if (!isWindowsOsType(osType)) {
    await db.query('UPDATE windows_pool_templates SET enabled = false, version = version + 1, updated_at = NOW() WHERE template_id = $1 AND enabled', [templateId]);
    return { newRevision: null };
  }
  return syncTemplateSource(db, templateId, proxmoxTemplateVmid);
}

async function windowsTemplate(db, templateId) {
  const template = (await db.query('SELECT os_type, proxmox_template_vmid FROM vm_templates WHERE id = $1', [templateId])).rows[0];
  if (!template) throw new PoolAdminError('NOT_FOUND', 'Unknown template', 404);
  if (!isWindowsOsType(template.os_type)) throw new PoolAdminError('NOT_WINDOWS', 'Only Windows templates can use the pool');
  return template;
}

export async function updateOperationLimit(db, { category, scope = 'cluster', maxActive }) {
  if (!LEASE_CATEGORIES.includes(category)) throw new PoolAdminError('VALIDATION', 'Unknown category');
  if (!Number.isInteger(maxActive) || maxActive < 0 || maxActive > 200) throw new PoolAdminError('VALIDATION', 'Ceiling between 0 and 200');
  if (!(scope === 'cluster' || /^(node|storage):[A-Za-z0-9._-]+$/.test(scope))) throw new PoolAdminError('VALIDATION', 'Invalid scope');
  await db.query(
    `INSERT INTO windows_pool_operation_limits (category, scope, max_active) VALUES ($1, $2, $3)
     ON CONFLICT (category, scope) DO UPDATE SET max_active = EXCLUDED.max_active, updated_at = NOW()`, [category, scope, maxActive]);
}

// Quarantine handled by an administrator: the VM is destroyed (after the manager checks its
// ownership marker). Never returned to the stock.
export async function destroyQuarantinedVm(db, poolVmId) {
  const vm = (await db.query('SELECT * FROM windows_pool_vms WHERE id = $1', [poolVmId])).rows[0];
  if (!vm) throw new PoolAdminError('NOT_FOUND', 'Unknown pool VM', 404);
  if (vm.state !== 'quarantined') throw new PoolAdminError('NOT_QUARANTINED', `VM in state ${vm.state}`, 409);
  await transitionPoolVm(db, { id: vm.id, from: 'quarantined', to: 'deleting', version: vm.version, detail: { code: 'QUARANTINE_RELEASED' } });
}

// Cancels a lab's open pool request (lab waiting or reserved and not yet assigned).
// The reserved VMs proven intact go back to the stock; the others are destroyed.
export async function cancelDeploymentPoolRequests({ db, proxmox, deploymentId }) {
  let requests;
  try {
    requests = (await db.query(
      `SELECT id, status FROM windows_pool_requests WHERE deployment_id = $1 AND status IN ('waiting_for_pool', 'reserved')`, [deploymentId])).rows;
  } catch (error) {
    if (error?.code === '42P01') return [];
    throw error;
  }
  const results = [];
  for (const request of requests) {
    results.push(request.status === 'reserved' && proxmox
      ? await cancelPoolRequestVerified({ db, proxmox, requestId: request.id })
      : await cancelPoolRequest(db, request.id));
  }
  return results;
}
