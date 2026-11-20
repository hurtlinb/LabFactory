import { DelayedError } from 'bullmq';

// Waiting for the pool from a BullMQ job (deploy / redeploy). Same pattern as
// lib/jobConcurrency.js: a waiting job is set aside with moveToDelayed + DelayedError, so it
// consumes neither an attempt nor a worker slot, and must not hold any lock (the caller
// releases its locks BEFORE calling this function, or calls it before taking them).

export class PoolRequestClosedError extends Error {
  constructor(request) {
    super(`Windows pool request ${request.id} ${request.status}${request.blocked_reason ? ` (${request.blocked_reason})` : ''}`);
    this.code = 'POOL_REQUEST_CLOSED';
    this.request = request;
  }
}

// Returns { status: 'reserved', vms } once the whole batch is reserved.
// While waiting: puts the job aside (DelayedError) after publishing the reason in its progress.
export async function awaitPoolReservation({ db, requestId, job, token, delayMs = 5_000, now = () => Date.now() }) {
  const request = (await db.query('SELECT * FROM windows_pool_requests WHERE id = $1', [requestId])).rows[0];
  if (!request) throw new Error(`Unknown Windows pool request ${requestId}`);
  if (request.status === 'reserved') {
    const vms = (await db.query(
      `SELECT * FROM windows_pool_vms WHERE request_id = $1 AND state IN ('reserved', 'configuring', 'assigned') ORDER BY vmid`,
      [requestId])).rows;
    return { status: 'reserved', vms };
  }
  if (request.status !== 'waiting_for_pool') throw new PoolRequestClosedError(request);
  await job.updateProgress?.({
    phase: 'waiting_for_pool',
    requestId,
    blockedReason: request.blocked_reason ?? null,
    waitingSince: request.created_at
  });
  await job.moveToDelayed(now() + delayMs, token);
  throw new DelayedError();
}

// Coordinator hook: wakes up right away the delayed job of the lab whose reservation has just
// been obtained (otherwise it would wake up at the end of its delay anyway).
export async function promoteDeploymentJob({ db, queue, requestId }) {
  const row = (await db.query(
    `SELECT d.last_job_id FROM windows_pool_requests r JOIN lab_deployments d ON d.id = r.deployment_id WHERE r.id = $1`,
    [requestId])).rows[0];
  if (!row?.last_job_id) return false;
  const job = await queue.getJob(String(row.last_job_id));
  if (!job || await job.getState() !== 'delayed') return false;
  await job.promote();
  return true;
}
