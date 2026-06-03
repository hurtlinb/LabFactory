import { promises as fs } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgPool } from './postgresClient.js';
import { logger } from '../logging/logger.js';
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const migrationCandidates = [
    path.resolve('db/migrations'),
    path.resolve(moduleDir, '../../../db/migrations')
];
async function resolveMigrationsDir() {
    for (const candidate of migrationCandidates) {
        try {
            await fs.access(candidate);
            return candidate;
        }
        catch {
            // Try the next path candidate.
        }
    }
    throw new Error(`No migrations directory found. Tried: ${migrationCandidates.join(', ')}`);
}
export async function runMigrations() {
    const migrationsDir = await resolveMigrationsDir();
    logger.info({ migrationsDir }, 'Checking migrations');
    const entries = await fs.readdir(migrationsDir);
    const sqlFiles = entries.filter(entry => entry.endsWith('.sql')).sort();
    for (const file of sqlFiles) {
        const filePath = path.join(migrationsDir, file);
        const sql = await fs.readFile(filePath, 'utf8');
        logger.info({ file }, 'Running migration');
        await pgPool.query(sql);
    }
}
const invokedAsScript = process.argv[1]?.endsWith('runMigrations.ts') ||
    process.argv[1]?.endsWith('runMigrations.js');
if (invokedAsScript) {
    runMigrations()
        .then(() => logger.info('Migrations finished'))
        .catch(err => {
        logger.error({ err }, 'Migration failed');
        process.exit(1);
    })
        .finally(() => pgPool.end().catch(() => undefined));
}
