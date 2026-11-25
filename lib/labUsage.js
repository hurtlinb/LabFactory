// Lab usage (migration 039): when a lab was last used, since when it is running, and the
// "probably forgotten" threshold configured on the Maintenance page.

export const FORGOTTEN_AFTER_DAYS_DEFAULT = 1;
export const FORGOTTEN_AFTER_DAYS_MIN = 1;
export const FORGOTTEN_AFTER_DAYS_MAX = 30;
// A running lab refreshes last_used_at at most this often (the lab list is polled).
export const LAST_USED_REFRESH_MS = 10 * 60 * 1000;

const DEFAULTS = Object.freeze({ forgottenAfterDays: FORGOTTEN_AFTER_DAYS_DEFAULT, updatedAt: null, updatedBy: null });

function toSettings(row) {
  if (!row) return { ...DEFAULTS };
  return {
    forgottenAfterDays: Number(row.forgotten_after_days) || FORGOTTEN_AFTER_DAYS_DEFAULT,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by ?? null
  };
}

export async function readLabUsageSettings(db) {
  try {
    const { rows } = await db.query('SELECT * FROM lab_usage_settings WHERE id');
    return toSettings(rows[0]);
  } catch (error) {
    if (error?.code === '42P01') return { ...DEFAULTS }; // migration 039 not applied yet
    throw error;
  }
}

export function validateLabUsageSettings(input) {
  const days = Number(input?.forgottenAfterDays);
  if (!Number.isInteger(days) || days < FORGOTTEN_AFTER_DAYS_MIN || days > FORGOTTEN_AFTER_DAYS_MAX) {
    return { errors: { forgottenAfterDays: [`Enter a whole number of days between ${FORGOTTEN_AFTER_DAYS_MIN} and ${FORGOTTEN_AFTER_DAYS_MAX}`] } };
  }
  return { value: { forgottenAfterDays: days } };
}

export async function writeLabUsageSettings(db, value, updatedBy = null) {
  const { rows } = await db.query(
    `INSERT INTO lab_usage_settings (id, forgotten_after_days, updated_by, updated_at)
     VALUES (TRUE, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET forgotten_after_days = EXCLUDED.forgotten_after_days,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [value.forgottenAfterDays, updatedBy]);
  return toSettings(rows[0]);
}

/**
 * Start time of the oldest VM of the lab that is still running, from the Proxmox
 * cluster resources (uptime in seconds). Null when no VM of the lab is running.
 */
export function runningSinceFromResources(vmids, resourceByVmid, now = Date.now()) {
  let earliest = null;
  for (const vmid of vmids) {
    const resource = resourceByVmid?.get(Number(vmid));
    if (resource?.status !== 'running') continue;
    const uptime = Number(resource.uptime);
    if (!Number.isFinite(uptime) || uptime < 0) continue;
    const startedAt = now - uptime * 1000;
    if (earliest === null || startedAt < earliest) earliest = startedAt;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/** Marks labs as used now (deploy/start/stop action, or VMs seen running). */
export async function recordLabUse(db, deploymentIds, { throttle = false } = {}) {
  const ids = [...new Set(deploymentIds)].filter(Boolean);
  if (!ids.length) return;
  try {
    await db.query(
      `UPDATE lab_deployments SET last_used_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND ($2::boolean = false OR last_used_at IS NULL OR last_used_at < NOW() - make_interval(secs => $3))`,
      [ids, throttle, LAST_USED_REFRESH_MS / 1000]);
  } catch (error) {
    if (error?.code === '42703') return; // column absent (migration 039 not applied yet)
    throw error;
  }
}
