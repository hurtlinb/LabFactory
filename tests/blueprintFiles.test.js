import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';

const root = await fs.mkdtemp(path.join(tmpdir(), 'labfactory-file-tests-'));
process.env.BLUEPRINT_FILES_DIR = root;
const { INSUFFICIENT_STORAGE_MESSAGE, isInsufficientStorageError, getBlueprintFileStorage, getFileUploads, validateFileUpload, receiveBlueprintFile, blueprintFileDirectory, persistFileUpload,
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

test('normalizes legacy single files and preserves multiple file entries', () => {
  const first = metadata(), second = metadata();
  assert.deepEqual(getFileUploads({}), []);
  assert.deepEqual(getFileUploads({ fileUpload: first }), [first]);
  assert.deepEqual(getFileUploads({ fileUploads: [first, second] }), [first, second]);
  assert.deepEqual(getFileUploads({ fileUploads: [], fileUpload: first }), []);
  assert.throws(() => getFileUploads({ fileUploads: 'invalid' }), /must be an array/);
});

test('storage inventory counts actual bytes once and includes legacy, missing and unlinked files', async () => {
  const inventoryRoot = await fs.mkdtemp(path.join(root, 'inventory-'));
  const blueprintId = randomUUID();
  const first = await receiveBlueprintFile(Readable.from(['12345']), blueprintId, { root: inventoryRoot });
  const second = await receiveBlueprintFile(Readable.from(['1234567']), blueprintId, { root: inventoryRoot });
  const orphan = await receiveBlueprintFile(Readable.from(['123']), blueprintId, { root: inventoryRoot });
  const missing = metadata();
  const legacy = metadata({ ...first, name: 'legacy.bin', size: 9999 });
  const rows = [
    { blueprint_id: blueprintId, blueprint_name: 'Test blueprint', config: { fileUpload: legacy } },
    { blueprint_id: blueprintId, blueprint_name: 'Test blueprint', config: { fileUploads: [legacy, metadata(second), missing] } }
  ];
  await fs.writeFile(path.join(inventoryRoot, blueprintId, 'ignored.txt'), 'not an uploaded file');
  const report = await getBlueprintFileStorage({ query: async () => ({ rows }) }, inventoryRoot);
  assert.equal(report.storedFileCount, 3);
  assert.equal(report.totalBytes, 15);
  assert.equal(report.files.length, 4);
  assert.equal(report.files.find(file => file.id === first.id).size, 5);
  assert.equal(report.files.find(file => file.id === first.id).blueprintName, 'Test blueprint');
  assert.equal(report.files.find(file => file.id === orphan.id).status, 'unreferenced');
  assert.equal(report.files.find(file => file.id === missing.id).status, 'missing');
  assert.equal(report.files.find(file => file.id === missing.id).size, null);
  const volume = await fs.statfs(inventoryRoot);
  assert.equal(report.capacityBytes, volume.blocks * volume.bsize);
  assert.ok(report.availableBytes >= 0 && report.availableBytes <= report.capacityBytes);
});

test('storage inventory works before the first upload and does not create directories', async () => {
  const absent = path.join(root, 'absent', 'uploads');
  const report = await getBlueprintFileStorage({ query: async () => ({ rows: [] }) }, absent);
  assert.deepEqual(report.files, []);
  assert.equal(report.totalBytes, 0);
  assert.equal(report.storedFileCount, 0);
  assert.ok(report.capacityBytes > 0);
  await assert.rejects(fs.access(absent), { code: 'ENOENT' });
});

test('rejects insufficient capacity before creating a file and permits a smaller upload', async () => {
  const blueprintId = randomUUID();
  const storageSpace = async () => ({ availableBytes: 3 });
  await assert.rejects(receiveBlueprintFile(Readable.from(['four']), blueprintId, { expectedBytes: 4, storageSpace }), {
    code: 'INSUFFICIENT_STORAGE', message: INSUFFICIENT_STORAGE_MESSAGE
  });
  await assert.rejects(fs.access(blueprintFileDirectory(blueprintId)), { code: 'ENOENT' });
  const accepted = await receiveBlueprintFile(Readable.from(['ok']), blueprintId, { expectedBytes: 2, storageSpace });
  assert.equal(accepted.size, 2);
});

test('disk-full and quota failures clean partial files and keep HTTP errors readable', async () => {
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const blueprintId = randomUUID();
    const existing = await receiveBlueprintFile(Readable.from(['keep existing']), blueprintId);
    const server = createServer(async (req, res) => {
      try {
        await receiveBlueprintFile(req, blueprintId, {
          createFileStream: destination => new Writable({
            write(chunk, encoding, callback) {
              fs.writeFile(destination, chunk.subarray(0, 1))
                .then(() => callback(Object.assign(new Error('simulated disk failure'), { code })), callback);
            }
          })
        });
        res.end('unexpected success');
      } catch (error) {
        res.writeHead(isInsufficientStorageError(error) ? 507 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port, {
        method: 'PUT', body: Readable.from([Buffer.alloc(65536), Buffer.alloc(65536)]), duplex: 'half'
      });
      assert.equal(response.status, 507);
      assert.deepEqual(await response.json(), { error: INSUFFICIENT_STORAGE_MESSAGE });
      assert.deepEqual(await fs.readdir(blueprintFileDirectory(blueprintId)), [existing.id]);
      assert.equal(await fs.readFile(path.join(blueprintFileDirectory(blueprintId), existing.id), 'utf8'), 'keep existing');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
