import { v4 as uuidv4 } from 'uuid';
import { pgPool } from '../../infrastructure/db/postgresClient.js';
const ACTIVE_SCHEDULING_STATUSES = ['scheduled', 'preparing', 'running'];
const mapExecution = (row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    requestedBy: row.requested_by,
    project: row.project,
    environment: row.environment,
    target: row.target,
    lockKey: row.lock_key,
    repository: row.repository,
    gitRef: row.git_ref,
    payload: row.payload ?? {},
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    exitCode: row.exit_code,
    errorSummary: row.error_summary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
});
const mapLog = (row) => ({
    id: row.id,
    executionId: row.execution_id,
    timestamp: row.timestamp.toISOString(),
    stream: row.stream,
    message: row.message
});
export class ExecutionRepository {
    async createExecution(input) {
        const id = uuidv4();
        const now = new Date();
        const payload = input.payload ?? {};
        const result = await pgPool.query(`INSERT INTO executions
        (id, type, status, requested_by, project, environment, target, lock_key, repository, git_ref, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`, [
            id,
            input.type,
            'queued',
            input.requestedBy,
            input.project,
            input.environment,
            input.target,
            input.lockKey,
            input.repository,
            input.gitRef,
            payload,
            now,
            now
        ]);
        return mapExecution(result.rows[0]);
    }
    async findById(id) {
        const result = await pgPool.query('SELECT * FROM executions WHERE id = $1', [id]);
        if (!result.rowCount)
            return null;
        return mapExecution(result.rows[0]);
    }
    async updateStatus(id, status, opts = {}) {
        const updates = ['status = $1', 'updated_at = $2'];
        const values = [status, new Date()];
        const push = (column, value) => {
            values.push(value);
            updates.push(`${column} = $${values.length}`);
        };
        if (Object.prototype.hasOwnProperty.call(opts, 'startedAt')) {
            push('started_at', opts.startedAt);
        }
        if (Object.prototype.hasOwnProperty.call(opts, 'finishedAt')) {
            push('finished_at', opts.finishedAt);
        }
        if (Object.prototype.hasOwnProperty.call(opts, 'exitCode')) {
            push('exit_code', opts.exitCode);
        }
        if (Object.prototype.hasOwnProperty.call(opts, 'errorSummary')) {
            push('error_summary', opts.errorSummary);
        }
        const sql = `UPDATE executions SET ${updates.join(', ')} WHERE id = $${values.length + 1} RETURNING *`;
        values.push(id);
        const result = await pgPool.query(sql, values);
        if (!result.rowCount)
            return null;
        return mapExecution(result.rows[0]);
    }
    async appendLog(log) {
        const id = uuidv4();
        await pgPool.query(`INSERT INTO execution_logs (id, execution_id, timestamp, stream, message)
       VALUES ($1, $2, NOW(), $3, $4)`, [id, log.executionId, log.stream, log.message]);
    }
    async listLogs(executionId) {
        const result = await pgPool.query('SELECT * FROM execution_logs WHERE execution_id = $1 ORDER BY timestamp ASC', [executionId]);
        return result.rows.map(mapLog);
    }
    async addArtifact(meta) {
        const id = uuidv4();
        const now = new Date();
        await pgPool.query(`INSERT INTO execution_artifacts (id, execution_id, kind, uri, created_at)
       VALUES ($1,$2,$3,$4,$5)`, [id, meta.executionId, meta.kind, meta.uri, now]);
        return { ...meta, id, createdAt: now.toISOString() };
    }
    async hasSchedulingConflict(execution) {
        let query = '';
        let values = [];
        if (execution.type === 'terraform_apply') {
            query = `SELECT 1
        FROM executions
        WHERE id != $1
          AND type = 'terraform_apply'
          AND project = $2
          AND environment = $3
          AND status = ANY($4::text[])
        LIMIT 1`;
            values = [execution.id, execution.project, execution.environment, ACTIVE_SCHEDULING_STATUSES];
        }
        else if (execution.type === 'terraform_plan') {
            query = `SELECT 1
        FROM executions
        WHERE id != $1
          AND type = 'terraform_apply'
          AND project = $2
          AND environment = $3
          AND status = ANY($4::text[])
        LIMIT 1`;
            values = [execution.id, execution.project, execution.environment, ACTIVE_SCHEDULING_STATUSES];
        }
        else {
            query = `SELECT 1
        FROM executions
        WHERE id != $1
          AND type = 'ansible_run'
          AND project = $2
          AND environment = $3
          AND target = $4
          AND status = ANY($5::text[])
        LIMIT 1`;
            values = [
                execution.id,
                execution.project,
                execution.environment,
                execution.target,
                ACTIVE_SCHEDULING_STATUSES
            ];
        }
        const result = await pgPool.query(query, values);
        return (result.rowCount ?? 0) > 0;
    }
}
