// Site-wide announcement banner (migration 038): one row, edited by admins from the
// Maintenance page, read by every authenticated user.

export const ANNOUNCEMENT_LEVELS = Object.freeze(['info', 'warning', 'danger']);
export const ANNOUNCEMENT_MAX_LENGTH = 500;

const EMPTY = Object.freeze({ enabled: false, level: 'info', message: '', endsAt: null, updatedAt: null, updatedBy: null });

function toAnnouncement(row) {
  if (!row) return { ...EMPTY };
  return {
    enabled: Boolean(row.enabled),
    level: ANNOUNCEMENT_LEVELS.includes(row.level) ? row.level : 'info',
    message: String(row.message ?? ''),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by ?? null
  };
}

/** Full configuration (admin view). */
export async function readAnnouncement(db) {
  try {
    const { rows } = await db.query('SELECT * FROM site_announcement WHERE id');
    return toAnnouncement(rows[0]);
  } catch (error) {
    if (error?.code === '42P01') return { ...EMPTY }; // migration 038 not applied yet
    throw error;
  }
}

/** What the banner shows right now: null when disabled, empty or past its end time. */
export function activeAnnouncement(announcement, now = new Date()) {
  if (!announcement?.enabled || !announcement.message.trim()) return null;
  if (announcement.endsAt && new Date(announcement.endsAt) <= now) return null;
  return { level: announcement.level, message: announcement.message, endsAt: announcement.endsAt, updatedAt: announcement.updatedAt };
}

export function validateAnnouncement(input) {
  const errors = {};
  const enabled = input?.enabled === true;
  const level = input?.level ?? 'info';
  if (!ANNOUNCEMENT_LEVELS.includes(level)) errors.level = ['Level must be info, warning or danger'];
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  if (message.length > ANNOUNCEMENT_MAX_LENGTH) errors.message = [`Message must be at most ${ANNOUNCEMENT_MAX_LENGTH} characters`];
  else if (enabled && !message) errors.message = ['A message is required to show the banner'];
  let endsAt = null;
  if (input?.endsAt !== undefined && input.endsAt !== null && input.endsAt !== '') {
    const date = new Date(input.endsAt);
    if (Number.isNaN(date.getTime())) errors.endsAt = ['End time is not a valid date'];
    else endsAt = date.toISOString();
  }
  if (Object.keys(errors).length) return { errors };
  return { value: { enabled, level, message, endsAt } };
}

export async function writeAnnouncement(db, value, updatedBy = null) {
  const { rows } = await db.query(
    `INSERT INTO site_announcement (id, enabled, level, message, ends_at, updated_by, updated_at)
     VALUES (TRUE, $1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, level = EXCLUDED.level, message = EXCLUDED.message,
       ends_at = EXCLUDED.ends_at, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [value.enabled, value.level, value.message, value.endsAt, updatedBy]);
  return toAnnouncement(rows[0]);
}
