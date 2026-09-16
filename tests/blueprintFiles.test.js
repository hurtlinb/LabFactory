import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';

const root = await fs.mkdtemp(path.join(tmpdir(), 'labfactory-file-tests-'));
process.env.BLUEPRINT_FILES_DIR = root;
const { validateFileUpload, receiveBlueprintFile, blueprintFileDirectory, persistFileUpload,
  resolveFileUpload, cleanupBlueprintFiles, lockBlueprintFiles, maxBlueprintFileBytes } = await import('../lib/blueprintFiles.js');
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const metadata = overrides => ({ id: randomUUID(), name: 'example.bin', directory: '/opt/lab/files', ...overrides });

test('validates OS-specific absolute paths, filenames and metadata-only payloads', () => {
  validateFileUpload(metadata(), 'ubuntu');
  validateFileUpload(metadata({ directory: 'C:\\Lab Files' }), 'windows11');
  validateFileUpload(metadata({ directory: 'D:/Lab/Files' }), 'windows-server');
  for (const upload of [metadata({ name: '../bad' }), metadata({ name: 'NUL.txt' }), metadata({ directory: '/tmp/../etc' }), metadata({ directory: '{{ lookup("pipe", "command") }}' }), metadata({ id: '../file' }), metadata({ contentBase64: 'YQ==' })]) {
    assert.throws(() => validateFileUpload(upload, 'ubuntu'));
  }
  assert.throws(() => validateFileUpload(metadata({ directory: 'relative' }), 'ubuntu'));
  assert.throws(() => validateFileUpload(metadata(), 'windows11'));
  assert.throws(() => blueprintFileDirectory('../outside'));
  assert.equal(maxBlueprintFileBytes, 1073741824);
});

test('streams 300 MiB to disk without a base64 or full-file buffer', async () => {
  const blueprintId = randomUUID();
  const chunk = Buffer.alloc(1024 * 1024, 0xa5);
  const expected = createHash('sha256');
  async function* chunks() { for (let index = 0; index < 300; index++) { expected.update(chunk); yield chunk; } }
  const stored = await receiveBlueprintFile(Readable.from(chunks()), blueprintId);
  assert.equal(stored.size, 300 * 1024 * 1024);
  const actual = createHash('sha256');
  for await (const data of createReadStream(path.join(root, blueprintId, stored.id))) actual.update(data);
  assert.equal(actual.digest('hex'), expected.digest('hex'));
});

test('removes partial files on size overflow and interrupted uploads; accepts empty files', async () => {
  const blueprintId = randomUUID();
  await assert.rejects(receiveBlueprintFile(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), blueprintId, { maxBytes: 10 }));
  assert.deepEqual(await fs.readdir(path.join(root, blueprintId)), []);
  async function* interrupted() { yield Buffer.from('partial'); throw new Error('disconnected'); }
  await assert.rejects(receiveBlueprintFile(Readable.from(interrupted()), blueprintId), /disconnected/);
  assert.deepEqual(await fs.readdir(path.join(root, blueprintId)), []);
  const empty = await receiveBlueprintFile(Readable.from([]), blueprintId);
  assert.equal(empty.size, 0);
});

test('rejects references to another blueprint before reading storage', async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  await assert.rejects(persistFileUpload(db, randomUUID(), metadata(), 'ubuntu'), /does not belong/);
  await assert.rejects(resolveFileUpload(db, randomUUID(), metadata(), 'ubuntu'), /missing/);
});

test('PostgreSQL metadata lifecycle, deployment lookup, rollback and deletion cleanup', { skip: !process.env.BLUEPRINT_FILES_TEST_DATABASE_URL }, async () => {
  const { Pool } = await import('pg');
  const schema = 'file_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.BLUEPRINT_FILES_TEST_DATABASE_URL });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: process.env.BLUEPRINT_FILES_TEST_DATABASE_URL, options: '-c search_path=' + schema });
  try {
    await db.query(`CREATE TABLE lab_blueprints (id UUID PRIMARY KEY);
      CREATE TABLE lab_blueprint_vms (id UUID PRIMARY KEY, blueprint_id UUID REFERENCES lab_blueprints ON DELETE CASCADE, config JSONB NOT NULL);
      CREATE TABLE lab_deployments (id UUID PRIMARY KEY, blueprint_id UUID REFERENCES lab_blueprints ON DELETE RESTRICT);`);
    const blueprintId = randomUUID(), vmId = randomUUID(), deploymentId = randomUUID();
    const stored = await receiveBlueprintFile(Readable.from([Buffer.from([0, 255, 128, 10])]), blueprintId);
    const upload = metadata(stored);
    await db.query('INSERT INTO lab_blueprints VALUES ($1)', [blueprintId]);
    await db.query('INSERT INTO lab_blueprint_vms VALUES ($1, $2, $3)', [vmId, blueprintId, { fileUpload: upload }]);
    const retained = await persistFileUpload(db, blueprintId, { ...upload, size: 999 }, 'ubuntu');
    assert.equal(retained.size, 4);
    await db.query('INSERT INTO lab_deployments VALUES ($1, $2)', [deploymentId, blueprintId]);
    const resolved = await resolveFileUpload(db, deploymentId, upload, 'ubuntu');
    assert.equal(resolved.destination, '/opt/lab/files/example.bin');
    assert.deepEqual(await fs.readFile(resolved.source), Buffer.from([0, 255, 128, 10]));
    const win = await resolveFileUpload(db, deploymentId, { ...upload, directory: 'C:\\Lab Files' }, 'windows11');
    assert.equal(win.destination, 'C:\\Lab Files\\example.bin');
    await assert.rejects(db.query('DELETE FROM lab_blueprints WHERE id = $1', [blueprintId]), /foreign key/);
    const orphan = await receiveBlueprintFile(Readable.from(['orphan']), blueprintId);
    await cleanupBlueprintFiles(db, blueprintId);
    await assert.rejects(fs.access(path.join(root, blueprintId, orphan.id)), { code: 'ENOENT' });
    await fs.access(resolved.source);
    const client = await db.connect();
    await client.query('BEGIN');
    await lockBlueprintFiles(client, blueprintId);
    await client.query("UPDATE lab_blueprint_vms SET config = '{}' WHERE id = $1", [vmId]);
    let cleaned = false;
    const cleanup = cleanupBlueprintFiles(db, blueprintId).then(() => { cleaned = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(cleaned, false, 'cleanup waits for an in-flight transaction');
    await client.query('ROLLBACK');
    client.release();
    await cleanup;
    await fs.access(resolved.source);
    await db.query('DELETE FROM lab_deployments WHERE id = $1', [deploymentId]);
    await db.query('DELETE FROM lab_blueprints WHERE id = $1', [blueprintId]);
    await cleanupBlueprintFiles(db, blueprintId);
    await assert.rejects(fs.access(path.join(root, blueprintId)), { code: 'ENOENT' });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
