import { z } from 'zod';
import { transitionPoolVm } from './states.js';
import { cancelPoolRequest } from './reservation.js';
import { cancelPoolRequestVerified } from './cancellation.js';
import { LEASE_CATEGORIES } from './leases.js';
import { isWindowsOsType } from './config.js';
import { TERRAFORM_LAB_VMID_RANGE } from '../vmidAvailability.js';
import { BUSY_LAB_STATUSES } from './manager.js';

// Windows pool administration (lot P6): overview, configuration, qualification,
// suspension, limits, quarantine, timelines, metrics. Called by the dashboard routes.

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
  vmidMax: z.number().int().min(100).max(999_999_999).optional()
}).strict().refine(value => (value.vmidMin === undefined) === (value.vmidMax === undefined),
  { message: 'vmidMin and vmidMax go together', path: ['vmidMin'] });

const MIN_VMID_RANGE_SIZE = 100;

const templateSchema = z.object({
  readyTarget: z.number().int().min(0).max(500),
  maxCapacity: z.number().int().min(1).max(500),
  maxParallelPreparations: z.number().int().min(1).max(32),
  // Empty / null = automatic placement (online node with the most free memory).
  node: z.union([proxmoxName, z.literal(''), z.null()]).optional().transform(value => value || null),
  storage: proxmoxName,
  sourceTemplateVmid: z.number().int().min(100),
  preparationTimeoutSeconds: z.number().int().min(300).max(7200).optional(),
  assignmentTimeoutSeconds: z.number().int().min(60).max(3600).optional()
}).strict().refine(value => value.readyTarget <= value.maxCapacity, { message: 'The ready target must not exceed the maximum capacity', path: ['readyTarget'] });

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
      dnsServers: settings.dns_servers, vmidMin: settings.vmid_min, vmidMax: settings.vmid_max
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
          enabled: row.enabled, readyTarget: row.ready_target, maxCapacity: row.max_capacity,
          maxParallelPreparations: row.max_parallel_preparations, node: row.node, storage: row.storage,
          revision: row.revision, sourceTemplateVmid: row.source_template_vmid,
          preparationTimeoutSeconds: row.preparation_timeout_seconds, assignmentTimeoutSeconds: row.assignment_timeout_seconds,
          qualified: row.qualified_revision != null && row.qualified_revision === row.revision,
          qualifiedRevision: row.qualified_revision, qualifiedAt: row.qualified_at, qualifiedBy: row.qualified_by,
          qualificationNote: row.qualification_note
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

// Creates or modifies a template configuration. Changing the Proxmox source template = a new
// revision: the template is then disabled until it is qualified again (linked clones).
export async function configureTemplate(db, templateId, input) {
  const value = parse(templateSchema, input);
  const template = (await db.query('SELECT os_type FROM vm_templates WHERE id = $1', [templateId])).rows[0];
  if (!template) throw new PoolAdminError('NOT_FOUND', 'Unknown template', 404);
  if (!isWindowsOsType(template.os_type)) throw new PoolAdminError('NOT_WINDOWS', 'Only Windows templates can use the pool');
  const existing = (await db.query('SELECT * FROM windows_pool_templates WHERE template_id = $1', [templateId])).rows[0];
  if (!existing) {
    await db.query(
      `INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage,
         source_template_vmid, preparation_timeout_seconds, assignment_timeout_seconds)
       VALUES ($1, false, $2, $3, $4, $5, $6, $7, COALESCE($8, 1800), COALESCE($9, 900))`,
      [templateId, value.readyTarget, value.maxCapacity, value.maxParallelPreparations, value.node, value.storage,
        value.sourceTemplateVmid, value.preparationTimeoutSeconds ?? null, value.assignmentTimeoutSeconds ?? null]);
    return { created: true, newRevision: false };
  }
  const newRevision = Number(existing.source_template_vmid) !== value.sourceTemplateVmid;
  await db.query(
    `UPDATE windows_pool_templates SET ready_target = $2, max_capacity = $3, max_parallel_preparations = $4, node = $5, storage = $6,
            source_template_vmid = $7,
            preparation_timeout_seconds = COALESCE($8, preparation_timeout_seconds),
            assignment_timeout_seconds = COALESCE($9, assignment_timeout_seconds),
            revision = CASE WHEN $10 THEN revision + 1 ELSE revision END,
            enabled = CASE WHEN $10 THEN false ELSE enabled END,
            version = version + 1, updated_at = NOW()
      WHERE template_id = $1`,
    [templateId, value.readyTarget, value.maxCapacity, value.maxParallelPreparations, value.node, value.storage,
      value.sourceTemplateVmid, value.preparationTimeoutSeconds ?? null, value.assignmentTimeoutSeconds ?? null, newRevision]);
  return { created: false, newRevision };
}

// Records that the CURRENT revision of the template has been qualified (P0 procedure: preparation
// without network, assignment, WinRM, persistence after reboot). Required to enable the template.
export async function qualifyTemplate(db, templateId, { actor, note }) {
  const result = await db.query(
    `UPDATE windows_pool_templates SET qualified_revision = revision, qualified_at = NOW(), qualified_by = $2,
            qualification_note = $3, version = version + 1, updated_at = NOW()
      WHERE template_id = $1 RETURNING revision`, [templateId, String(actor ?? 'unknown').slice(0, 200), note ? String(note).slice(0, 2000) : null]);
  if (!result.rowCount) throw new PoolAdminError('NOT_CONFIGURED', 'Configure the template before qualifying it', 404);
  return { revision: result.rows[0].revision };
}

// Enabling (qualification required, enforced by the database) / disabling (controlled suspension
// of the template: no new assignment; labs in place and VMs already assigned untouched).
export async function setTemplateEnabled(db, templateId, enabled) {
  try {
    const result = await db.query(
      'UPDATE windows_pool_templates SET enabled = $2, version = version + 1, updated_at = NOW() WHERE template_id = $1',
      [templateId, Boolean(enabled)]);
    if (!result.rowCount) throw new PoolAdminError('NOT_CONFIGURED', 'Template not configured for the pool', 404);
  } catch (error) {
    if (error.code === '23514' && /enabled_qualified/.test(error.constraint ?? error.message)) {
      throw new PoolAdminError('NOT_QUALIFIED', 'Qualify the current revision of the template before enabling it', 409);
    }
    if (error.code === '23514' && /enabled_placement/.test(error.constraint ?? error.message)) {
      throw new PoolAdminError('NO_PLACEMENT', 'Storage required before enabling', 409);
    }
    throw error;
  }
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
