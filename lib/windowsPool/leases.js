import { randomUUID } from 'node:crypto';

// Distributed operation ceilings (PostgreSQL), valid across every worker/replica.
// - Atomic multi-scope acquisition (e.g. cluster + node + storage): all or nothing,
//   locks taken in sorted order -> no deadlock between limits.
// - Short transaction: a refusal holds nothing; the caller retries later (backoff)
//   without keeping a worker slot.
// - A lease tied to a Proxmox task (proxmox_upid) KEEPS COUNTING after it expires:
//   only a reconciliation (task finished on the Proxmox side) may release it.

const LOCK_NAMESPACE = 1279346247; // distinct from lib/jobConcurrency.js
export const LEASE_CATEGORIES = Object.freeze(['clone', 'prepare', 'guest_probe', 'assign', 'customize', 'lifecycle', 'destroy']);

export function leaseScopes({ node, storage } = {}) {
  const scopes = ['cluster'];
  if (node) scopes.push(`node:${node}`);
  if (storage) scopes.push(`storage:${storage}`);
  return scopes;
}

// Returns { ids, scopes } or null if a ceiling is reached. A scope without a configured limit
// is not limited (only 'cluster' is seeded by migration 032).
export async function tryAcquireLease(pool, { category, scopes = ['cluster'], holder, poolVmId = null, ttlSeconds = 120 }) {
  if (!LEASE_CATEGORIES.includes(category)) throw new Error(`Unknown lease category: ${category}`);
  if (!holder) throw new Error('A lease holder is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sorted = [...new Set(scopes)].sort();
    for (const scope of sorted) {
      await client.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2))', [LOCK_NAMESPACE, `${category}|${scope}`]);
    }
    // Expired leases without a Proxmox task: abandoned holder, safe to reclaim.
    await client.query(
      `DELETE FROM windows_pool_operation_leases
        WHERE category = $1 AND scope = ANY($2::text[]) AND expires_at < NOW() AND proxmox_upid IS NULL`,
      [category, sorted]);
    const limits = (await client.query(
      `SELECT l.scope, l.max_active,
              (SELECT COUNT(*)::int FROM windows_pool_operation_leases x
                WHERE x.category = l.category AND x.scope = l.scope) AS active
         FROM windows_pool_operation_limits l
        WHERE l.category = $1 AND l.scope = ANY($2::text[])`,
      [category, sorted])).rows;
    if (limits.some(limit => limit.active >= limit.max_active)) {
      await client.query('ROLLBACK');
      return null;
    }
    const limited = new Set(limits.map(limit => limit.scope));
    const ids = [];
    for (const scope of sorted.filter(value => limited.has(value))) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO windows_pool_operation_leases (id, category, scope, holder, pool_vm_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))`,
        [id, category, scope, holder, poolVmId, ttlSeconds]);
      ids.push(id);
    }
    await client.query('COMMIT');
    return { ids, scopes: sorted, category };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Heartbeat: extends the leases of a running operation.
export async function renewLease(pool, lease, ttlSeconds = 120) {
  const result = await pool.query(
    `UPDATE windows_pool_operation_leases SET expires_at = NOW() + make_interval(secs => $2)
      WHERE id = ANY($1::uuid[])`, [lease.ids, ttlSeconds]);
  if (result.rowCount !== lease.ids.length) throw Object.assign(new Error('Lease lost'), { code: 'LEASE_LOST' });
}

// Attaches the Proxmox task: from now on, expiry no longer releases the budget.
export async function attachProxmoxTask(pool, lease, upid) {
  if (!upid) throw new Error('Proxmox UPID required');
  await pool.query('UPDATE windows_pool_operation_leases SET proxmox_upid = $2 WHERE id = ANY($1::uuid[])', [lease.ids, upid]);
}

export async function releaseLease(pool, lease) {
  if (!lease?.ids?.length) return;
  await pool.query('DELETE FROM windows_pool_operation_leases WHERE id = ANY($1::uuid[])', [lease.ids]);
}

// Limiter backed by a distributed budget (e.g. 'customize'): limit(fn) waits for a lease (without
// holding any lock), runs fn, renews the lease while it runs (operation longer than its TTL),
// then releases it. If the pool tables do not exist yet (migration 032 not applied):
// falls back to the local `fallback` limiter.
export function createLeaseLimiter({ pool, category, holder, fallback, retryMs = 1_000, ttlSeconds = 300, log = console }) {
  let missingSchema = false;
  return async fn => {
    if (missingSchema) return fallback(fn);
    let lease = null;
    for (;;) {
      try {
        lease = await tryAcquireLease(pool, { category, holder, ttlSeconds });
      } catch (error) {
        if (error?.code === '42P01' && fallback) {
          missingSchema = true;
          log.warn?.(`[limits] table ${category} missing: local limit`);
          return fallback(fn);
        }
        throw error;
      }
      if (lease) break;
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
    const heartbeat = setInterval(() => { renewLease(pool, lease, ttlSeconds).catch(() => undefined); }, Math.max(1_000, (ttlSeconds * 1000) / 3));
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await releaseLease(pool, lease).catch(() => undefined);
    }
  };
}

// Reconciliation after a crash: for each expired lease tied to a task, ask Proxmox
// (getTaskStatus(upid) -> 'running' | 'stopped' | 'unknown'). Release only if the task is
// finished; 'unknown' keeps the budget (fail closed).
export async function reconcileOrphanLeases(pool, getTaskStatus) {
  const orphans = (await pool.query(
    `SELECT DISTINCT proxmox_upid FROM windows_pool_operation_leases
      WHERE expires_at < NOW() AND proxmox_upid IS NOT NULL`)).rows;
  let released = 0;
  for (const { proxmox_upid: upid } of orphans) {
    let status;
    try { status = await getTaskStatus(upid); } catch { status = 'unknown'; }
    if (status !== 'stopped') continue;
    const result = await pool.query(
      'DELETE FROM windows_pool_operation_leases WHERE proxmox_upid = $1 AND expires_at < NOW()', [upid]);
    released += result.rowCount;
  }
  return released;
}
