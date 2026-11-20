import { randomUUID } from 'node:crypto';

// Atomic reservation of a lab's whole Windows demand.
// - All or nothing: no partial batch is ever reserved.
// - FIFO fairness per template: an older request that needs the same template
//   keeps priority (no starvation of large labs).
// - FOR UPDATE SKIP LOCKED: two workers never reserve the same VM.
// - Short transactions: waiting holds neither a lock nor a worker slot.

export const STOCK_NOTIFY_CHANNEL = 'windows_pool_stock';
export const REQUEST_NOTIFY_CHANNEL = 'windows_pool_requests';

async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function normalizeDemand(demand) {
  if (!Array.isArray(demand) || !demand.length) throw new Error('Empty Windows demand');
  const seen = new Set();
  for (const item of demand) {
    if (!item?.templateId || !Number.isInteger(item.count) || item.count < 1) throw new Error('Invalid Windows demand');
    if (seen.has(item.templateId)) throw new Error('Template repeated in the demand');
    seen.add(item.templateId);
  }
  return demand.map(({ templateId, count }) => ({ templateId, count }));
}

export async function createPoolRequest(db, { deploymentId, kind, demand, runId = null }) {
  const id = randomUUID();
  // The notification is sent at commit: the coordinator immediately tries to serve it.
  const result = await db.query(
    `WITH inserted AS (
       INSERT INTO windows_pool_requests (id, deployment_id, kind, demand, run_id)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *
     ), notified AS (SELECT pg_notify('${REQUEST_NOTIFY_CHANNEL}', id::text) FROM inserted)
     SELECT inserted.* FROM inserted, notified`,
    [id, deploymentId, kind, JSON.stringify(normalizeDemand(demand)), runId]
  );
  return result.rows[0];
}

// Tries to reserve. Returns { status: 'reserved', vms } or { status: 'waiting', reason, missing }
// or { status: 'unchanged' } if the request is no longer waiting.
export async function reservePoolRequest(pool, requestId) {
  return inTransaction(pool, async client => {
    const requestResult = await client.query(
      'SELECT * FROM windows_pool_requests WHERE id = $1 FOR UPDATE', [requestId]);
    const request = requestResult.rows[0];
    if (!request) throw new Error(`Unknown pool request ${requestId}`);
    if (request.status !== 'waiting_for_pool') return { status: 'unchanged', request };

    const setBlocked = async (reason, missing = []) => {
      await client.query(
        `UPDATE windows_pool_requests SET blocked_reason = $2, updated_at = NOW()
          WHERE id = $1 AND blocked_reason IS DISTINCT FROM $2`, [requestId, reason]);
      return { status: 'waiting', reason, missing };
    };

    const settings = (await client.query('SELECT paused FROM windows_pool_settings WHERE id')).rows[0];
    if (!settings || settings.paused) return setBlocked('POOL_PAUSED');

    const demand = normalizeDemand(request.demand);
    const templateIds = demand.map(item => item.templateId);
    const templates = new Map((await client.query(
      'SELECT template_id, enabled, revision, max_capacity FROM windows_pool_templates WHERE template_id = ANY($1::uuid[])',
      [templateIds])).rows.map(row => [row.template_id, row]));
    for (const item of demand) {
      const template = templates.get(item.templateId);
      if (!template?.enabled) return setBlocked('TEMPLATE_DISABLED', [{ ...item, available: 0 }]);
      if (item.count > template.max_capacity) return setBlocked('DEMAND_EXCEEDS_CAPACITY', [{ ...item, available: 0 }]);
    }

    // FIFO per template: an older waiting request for the same template goes first.
    // Except a request that cannot be served for a reason other than the stock (demand >
    // ceiling, disabled template): it must not block the following ones (head-of-line blocking).
    // It gets its rank back once the cause is lifted (rank = creation date).
    const ahead = await client.query(
      `SELECT 1 FROM windows_pool_requests r
        WHERE r.status = 'waiting_for_pool' AND r.id <> $1
          AND COALESCE(r.blocked_reason, '') NOT IN ('DEMAND_EXCEEDS_CAPACITY', 'TEMPLATE_DISABLED')
          AND (r.created_at, r.id) < ($2::timestamptz, $1::uuid)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.demand) d
                       WHERE (d->>'templateId')::uuid = ANY($3::uuid[]))
        LIMIT 1`,
      [requestId, request.created_at, templateIds]);
    if (ahead.rowCount) return setBlocked('QUEUED_BEHIND_OLDER_REQUEST');

    const selected = [];
    const missing = [];
    for (const item of demand) {
      const { revision } = templates.get(item.templateId);
      const rows = (await client.query(
        `SELECT id, version FROM windows_pool_vms
          WHERE template_id = $1 AND revision = $2 AND state = 'ready'
          ORDER BY ready_at, id
          LIMIT $3
          FOR UPDATE SKIP LOCKED`,
        [item.templateId, revision, item.count])).rows;
      if (rows.length < item.count) missing.push({ ...item, available: rows.length });
      selected.push(...rows);
    }
    if (missing.length) {
      // Nothing is reserved: the row locks are released at commit time.
      return setBlocked('INSUFFICIENT_STOCK', missing);
    }

    const ids = selected.map(row => row.id);
    const reserved = await client.query(
      `WITH updated AS (
         UPDATE windows_pool_vms
            SET state = 'reserved', request_id = $2, version = version + 1,
                reserved_at = NOW(), state_changed_at = NOW()
          WHERE id = ANY($1::uuid[]) AND state = 'ready'
          RETURNING *
       ), logged AS (
         INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
         SELECT id, 'ready', 'reserved', jsonb_build_object('requestId', $2::text) FROM updated
       )
       SELECT * FROM updated`,
      [ids, requestId]);
    if (reserved.rowCount !== ids.length) throw new Error('Inconsistent reservation: VMs changed concurrently');
    await client.query(
      `UPDATE windows_pool_requests
          SET status = 'reserved', reserved_at = NOW(), blocked_reason = NULL,
              version = version + 1, updated_at = NOW()
        WHERE id = $1`, [requestId]);
    return { status: 'reserved', vms: reserved.rows };
  });
}

// Cancellation. Returns to the stock ONLY the reserved VMs that the caller has
// re-verified intact (still disconnected, untouched): `verifiedIntactIds`. All the others
// (configuring, or reserved but not verified) are sent to destruction.
export async function cancelPoolRequest(pool, requestId, { verifiedIntactIds = [] } = {}) {
  return inTransaction(pool, async client => {
    const request = (await client.query(
      'SELECT * FROM windows_pool_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
    if (!request) throw new Error(`Unknown pool request ${requestId}`);
    if (!['waiting_for_pool', 'reserved'].includes(request.status)) return { status: 'unchanged', released: [], toDelete: [] };
    const vms = (await client.query(
      `SELECT id, state FROM windows_pool_vms WHERE request_id = $1 AND state IN ('reserved', 'configuring')
        FOR UPDATE`, [requestId])).rows;
    const intact = new Set(verifiedIntactIds);
    const released = vms.filter(vm => vm.state === 'reserved' && intact.has(vm.id)).map(vm => vm.id);
    const toDelete = vms.filter(vm => !released.includes(vm.id)).map(vm => vm.id);
    if (released.length) {
      await client.query(
        `WITH updated AS (
           UPDATE windows_pool_vms SET state = 'ready', request_id = NULL, reserved_at = NULL,
                  version = version + 1, state_changed_at = NOW()
            WHERE id = ANY($1::uuid[]) AND state = 'reserved' RETURNING id)
         INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
         SELECT id, 'reserved', 'ready', jsonb_build_object('cancelledRequestId', $2::text) FROM updated`,
        [released, requestId]);
    }
    if (toDelete.length) {
      await client.query(
        `WITH current AS (SELECT id, state FROM windows_pool_vms WHERE id = ANY($1::uuid[])),
         updated AS (
           UPDATE windows_pool_vms v SET state = 'deleting', version = v.version + 1, state_changed_at = NOW()
             FROM current c WHERE v.id = c.id RETURNING v.id, c.state AS from_state)
         INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
         SELECT id, from_state, 'deleting', jsonb_build_object('cancelledRequestId', $2::text) FROM updated`,
        [toDelete, requestId]);
    }
    await client.query(
      `UPDATE windows_pool_requests SET status = 'cancelled', finished_at = NOW(),
              version = version + 1, updated_at = NOW() WHERE id = $1`, [requestId]);
    if (released.length) await client.query(`SELECT pg_notify('${STOCK_NOTIFY_CHANNEL}', $1)`, [requestId]);
    return { status: 'cancelled', released, toDelete };
  });
}
