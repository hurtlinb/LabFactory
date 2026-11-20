import { DelayedError } from 'bullmq';

const LOCK_NAMESPACE = 1279346246;
export function workerConcurrency(value, fallback) {
  const count = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Worker concurrency must be an integer from 1 to 8');
  return count;
}

// Session locks are shared by Terraform and Ansible, including across processes.
// Never return a connection holding advisory locks to the pool.
export async function tryJobLocks(pool, keys, controller) {
  const client = await pool.connect();
  let released = false;
  let lost = null;
  let timer;
  let probe;
  const onError = error => {
    lost ||= error;
    controller?.abort(error);
  };
  client.on('error', onError);
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    if (probe) await probe;
    client.release(true);
  };
  const held = new Set();
  try {
    for (const key of [...new Set(keys)].sort()) {
      const result = await client.query({
        text: 'SELECT pg_try_advisory_lock($1::integer, hashtext($2)) AS acquired',
        values: [LOCK_NAMESPACE, key], query_timeout: 5000
      });
      if (!result.rows[0].acquired) { await release(); return null; }
      held.add(key);
    }
    timer = setInterval(() => {
      if (probe || released || lost) return;
      probe = client.query({ text: 'SELECT 1', query_timeout: 5000 })
        .catch(onError).finally(() => { probe = null; });
    }, 5000);
    timer.unref?.();
    // Early release of ONE key (e.g. global:terraform-deploy after apply) while keeping the
    // others (lab:<id>) on the same session. Idempotent.
    const releaseKey = async key => {
      if (released || !held.has(key)) return;
      held.delete(key);
      await client.query({
        text: 'SELECT pg_advisory_unlock($1::integer, hashtext($2)) AS released',
        values: [LOCK_NAMESPACE, key], query_timeout: 5000
      });
    };
    return {
      release,
      releaseKey,
      holds: key => !released && held.has(key),
      assertHeld() { if (lost) throw lost; controller?.signal.throwIfAborted(); }
    };
  } catch (error) { await release(); throw error; }
}

export const GLOBAL_TERRAFORM_DEPLOY_LOCK = 'global:terraform-deploy';

// global:terraform-deploy serializes the Terraform CREATIONS across the cluster (the computed
// VMIDs of two labs can collide: preflight + apply must not interleave). The worker
// releases it right after apply (lease.releaseKey): readiness, pool assignments and
// customizations do not hold it (lot P4c).
export async function acquireJobLocks(pool, job, token, controller, { deploy = false } = {}) {
  const labId = job.data.deploymentId || job.data.labInstanceId;
  const keys = [`lab:${labId || 'legacy'}`];
  if (deploy) keys.push(GLOBAL_TERRAFORM_DEPLOY_LOCK);
  const lease = await tryJobLocks(pool, keys, controller);
  if (lease) return lease;
  // A waiting deploy must not consume a worker slot or an attempt.
  await job.moveToDelayed(Date.now() + 1500, token);
  throw new DelayedError();
}

export async function recoverDeploymentJobs(pool, queue, statuses, action) {
  const candidates = await pool.query('SELECT id, status, last_job_id, last_run_id FROM lab_deployments WHERE status = ANY($1::text[])', [statuses]);
  let recovered = 0;
  for (const row of candidates.rows) {
    const lease = await tryJobLocks(pool, [`lab:${row.id}`]);
    if (!lease) continue;
    try {
      const job = row.last_job_id ? await queue.getJob(String(row.last_job_id)) : null;
      if (job && !['completed', 'failed', 'unknown'].includes(await job.getState())) continue;
      lease.assertHeld();
      const result = await pool.query(
        `UPDATE lab_deployments SET status = 'failed', last_action = $4, updated_at = NOW()
         WHERE id = $1 AND status = $2 AND last_run_id IS NOT DISTINCT FROM $3
           AND last_job_id IS NOT DISTINCT FROM $5`,
        [row.id, row.status, row.last_run_id, action, row.last_job_id]
      );
      recovered += result.rowCount;
    } finally { await lease.release(); }
  }
  return recovered;
}
