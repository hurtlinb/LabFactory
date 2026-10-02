import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const source = readFileSync('dashboard/server.js', 'utf8');
function route(start, end, overrides = {}) {
  let handler;
  const context = {
    app: { post: (...args) => { handler = args.at(-1); }, put: (...args) => { handler = args.at(-1); } },
    auth: { ROLE_GROUPS: { LABS: 'labs', ADMIN_ONLY: 'admin' }, requireRole: role => role },
    wrapAsync: callback => callback,
    ...overrides
  };
  vm.runInNewContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  return handler;
}
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

test('history cleanup only cleans completed/failed jobs, without pausing or cancelling queues', async () => {
  const cleaned = [];
  const handler = route("app.post('/api/jobs/clear-history'", "app.post('/api/jobs/cancel-all'", {
    queues: { terraform: { clean: async (_grace, _limit, status) => { cleaned.push(status); return []; } } }
  });
  const res = response(); await handler({}, res);
  assert.deepEqual(cleaned, ['completed', 'failed']);
  assert.equal(res.body.ok, true);
});

test('job cancellation preserves finished history and the original queue pause state', async () => {
  const actions = [];
  const queue = name => ({
    isPaused: async () => name === 'ansible',
    pause: async () => actions.push(`${name}:pause`),
    resume: async () => actions.push(`${name}:resume`),
    getJobs: async statuses => { assert(!statuses.includes('completed')); assert(!statuses.includes('failed')); return []; }
  });
  const handler = route("app.post('/api/jobs/cancel-all'", "app.get('/api/workers'", {
    queues: { terraform: queue('terraform'), ansible: queue('ansible') },
    queueNames: { terraform: 'terraform', ansible: 'ansible' },
    redisClient: { hGetAll: async () => ({ status: 'paused' }), publish: async (_channel, action) => actions.push(action) },
    resetTransientLifecycleStates: async () => {}, console
  });
  const res = response(); await handler({}, res);
  assert.equal(res.body.ok, true);
  assert(actions.includes('terraform:resume'));
  assert(!actions.includes('ansible:resume'));
  assert.equal(actions.filter(action => action === 'cancel-active').length, 2);
});

test('duplicate copies file contents and VM configuration with new VM IDs in one transaction', async () => {
  const queries = [], files = [], locks = [];
  const client = { release() {}, async query(sql, args) {
    queries.push({ sql, args });
    if (sql.includes('SELECT id FROM lab_blueprints')) return { rowCount: 1 };
    if (sql.includes('SELECT * FROM lab_blueprint_vms')) return { rows: [{ template_id: 'template', name: 'VM', vm_order: 0, config: { fileUploads: [{ id: 'file', name: 'test.txt' }] } }] };
    return { rows: [] };
  } };
  let nextId = 0;
  const handler = route("app.post('/api/blueprints/:id/duplicate'", "app.get(\n  '/api/blueprints/:id'", {
    uuidv4: () => `new-${++nextId}`, upsertTeacher: async () => 'teacher@example.test',
    dbPool: { connect: async () => client }, lockBlueprintFiles: async (_client, id) => locks.push(id),
    fs: { mkdir: async () => {}, copyFile: async (from, to) => files.push([from, to]) }, path,
    blueprintFileDirectory: id => path.join('storage', id), getFileUploads: config => config.fileUploads,
    validateFileUpload() {}, cleanupBlueprintFiles: async () => { throw new Error('Should not clean committed clone'); },
    fetchBlueprintById: async id => ({ id })
  });
  const res = response(); await handler({ params: { id: 'original' } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(locks, ['original', 'new-1']);
  assert.deepEqual(files, [[path.join('storage', 'original', 'file'), path.join('storage', 'new-1', 'file')]]);
  assert.equal(queries.find(q => q.sql.includes('INSERT INTO lab_blueprint_vms')).args[0], 'new-2');
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('duplicate rolls back and cleans the new file directory when a file is missing', async () => {
  const queries = [], cleanup = [];
  const client = { release() {}, async query(sql) {
    queries.push(sql);
    if (sql.includes('SELECT id FROM lab_blueprints')) return { rowCount: 1 };
    if (sql.includes('SELECT * FROM lab_blueprint_vms')) return { rows: [{ config: { fileUploads: [{ id: 'missing' }] } }] };
    return { rows: [] };
  } };
  const handler = route("app.post('/api/blueprints/:id/duplicate'", "app.get(\n  '/api/blueprints/:id'", {
    uuidv4: () => 'copy', upsertTeacher: async () => null, dbPool: { connect: async () => client },
    lockBlueprintFiles: async () => {}, getFileUploads: config => config.fileUploads, validateFileUpload() {},
    blueprintFileDirectory: id => id, path, fs: { mkdir: async () => {}, copyFile: async () => { throw new Error('Missing file'); } },
    cleanupBlueprintFiles: async (_pool, id) => cleanup.push(id)
  });
  await assert.rejects(handler({ params: { id: 'original' } }, response()), /Missing file/);
  assert.equal(queries.at(-1), 'ROLLBACK'); assert.deepEqual(cleanup, ['copy']);
});
