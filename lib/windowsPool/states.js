// Life cycle of a pool VM. Invariant: a VM that has entered a lab
// (configuring/assigned) is never returned to the clean stock: it goes to destruction.
export const POOL_VM_STATES = Object.freeze([
  'creating', 'preparing', 'ready', 'reserved', 'configuring', 'assigned',
  'deleting', 'deleted', 'quarantined'
]);

const TRANSITIONS = Object.freeze({
  creating: ['preparing', 'deleting', 'quarantined'],
  preparing: ['ready', 'deleting', 'quarantined'],
  ready: ['reserved', 'deleting', 'quarantined'],
  // Returning to ready is allowed only for an intact reservation, re-verified first (cancellation).
  reserved: ['configuring', 'ready', 'deleting', 'quarantined'],
  configuring: ['assigned', 'deleting', 'quarantined'],
  assigned: ['deleting', 'quarantined'],
  // An uncertain situation is never resolved by an automatic return to the stock.
  quarantined: ['deleting'],
  deleting: ['deleted', 'quarantined'],
  deleted: []
});

// States in which the VM still counts against the template capacity (outside labs).
export const STOCK_STATES = Object.freeze(['creating', 'preparing', 'ready']);
// States in which the network may have been changed for a lab: destruction only.
export const DIRTY_STATES = Object.freeze(['configuring', 'assigned']);

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!POOL_VM_STATES.includes(to)) throw new Error(`Unknown pool VM state: ${to}`);
  if (!canTransition(from, to)) throw new Error(`Forbidden pool VM transition: ${from} -> ${to}`);
}

const TIMESTAMP_COLUMN = { ready: 'ready_at', reserved: 'reserved_at', assigned: 'assigned_at', deleted: 'deleted_at' };

// Transition with optimistic version control: fails if another worker has already
// changed the VM (stale version) or if the transition is invalid. Returns the updated row.
export async function transitionPoolVm(db, { id, from, to, version, detail = {}, patch = {} }) {
  assertTransition(from, to);
  const allowedPatch = ['request_id', 'mac', 'current_task_upid', 'checkpoint', 'error_code', 'last_error', 'node'];
  const sets = ['state = $2::text', 'version = version + 1', 'state_changed_at = NOW()'];
  const values = [id, to, from, version];
  for (const [key, value] of Object.entries(patch)) {
    if (!allowedPatch.includes(key)) throw new Error(`Field not allowed in a transition: ${key}`);
    values.push(value);
    sets.push(`${key} = $${values.length}`);
  }
  if (TIMESTAMP_COLUMN[to]) sets.push(`${TIMESTAMP_COLUMN[to]} = NOW()`);
  values.push(detail);
  // Single statement: the transition and its log entry are atomic, even outside a transaction.
  const result = await db.query(
    `WITH updated AS (
       UPDATE windows_pool_vms SET ${sets.join(', ')}
        WHERE id = $1 AND state = $3 AND version = $4
        RETURNING *
     ), logged AS (
       INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
       SELECT id, $3::text, $2::text, $${values.length}::jsonb FROM updated
     )
     SELECT * FROM updated`,
    values
  );
  if (!result.rowCount) {
    throw Object.assign(new Error(`Pool VM ${id} changed concurrently (expected ${from} v${version})`), { code: 'POOL_VM_STALE' });
  }
  return result.rows[0];
}
