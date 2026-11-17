import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { z } from 'zod';

const source = readFileSync('dashboard/server.js', 'utf8').replace(/\r\n/g, '\n');
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

test('management permission follows the transferred owner rather than the blueprint creator', () => {
  const context = { auth: { enabled: true, ROLES: { ADMIN: 'admin' } } };
  vm.runInNewContext(source.slice(source.indexOf('const normalizeEmail ='), source.indexOf('app.use(auth.attachUser)')) + '\nthis.canManage = canManageDeployment;', context);
  const deployment = { teacherEmail: 'new@example.test', blueprint: { teacherEmail: 'old@example.test' } };
  const request = email => ({ auth: { user: { email, roles: ['teacher'] } } });
  assert.equal(context.canManage(request(' NEW@example.test '), deployment), true);
  assert.equal(context.canManage(request('old@example.test'), deployment), false);
});

test('owner transfer requires admin and validates the user and operation state before updating', async () => {
  for (const scenario of ['success', 'invalid', 'missing', 'unknown', 'busy']) {
    const queries = [];
    let requiredRole;
    const handler = route("app.put('/api/lifecycle/deployments/:id/owner'", "app.post(\n  '/api/lifecycle/deployments/refresh-state'", {
      z, normalizeEmail: value => value.trim().toLowerCase(),
      auth: { ROLE_GROUPS: { ADMIN_ONLY: 'admin' }, requireRole: role => { requiredRole = role; return role; } },
      deploymentBusyStatuses: new Set(['deploying', 'destroying']),
      fetchDeploymentById: async id => scenario === 'missing' ? null : { id, teacherEmail: 'new@example.test' },
      dbPool: { query: async (sql, args) => {
        queries.push({ sql, args });
        return { rowCount: (sql.startsWith('SELECT') && scenario === 'unknown') || (sql.includes('UPDATE') && scenario === 'busy') ? 0 : 1 };
      } }
    });
    assert.equal(requiredRole, 'admin');
    const res = response();
    await handler({ params: { id: 'lab' }, body: { teacherEmail: scenario === 'invalid' ? 'invalid' : ' NEW@example.test ' } }, res);
    assert.equal(res.statusCode, { success: 200, invalid: 400, missing: 404, unknown: 400, busy: 409 }[scenario]);
    const update = queries.find(query => query.sql.includes('UPDATE'));
    assert.equal(Boolean(update), ['success', 'busy'].includes(scenario));
    if (update) {
      assert.equal(update.args[1], 'new@example.test');
      assert.match(update.sql, /NOT \(status = ANY/);
    }
    if (scenario === 'success') assert.equal(res.body.teacherEmail, 'new@example.test');
  }
});

test('destroy checks live VMs for an idle lab while preserving owner and availability guards', async () => {
  for (const scenario of ['existing', 'absent', 'unavailable', 'foreign']) {
    const jobs = [], writes = [];
    const handler = route("app.post(\n  '/api/lifecycle/deployments/:id/:action'", "app.delete(\n  '/api/lifecycle/deployments/:id'", {
      fetchDeploymentById: async () => ({ id: 'lab', status: 'idle', blueprint: { id: 'bp' }, classroom: { id: 'room' }, teacher: { email: 'new@example.test' } }),
      canManageDeployment: () => scenario !== 'foreign',
      denyDeploymentManagement: res => res.status(403).json({ error: 'forbidden' }),
      deploymentBusyStatuses: new Set(['destroying']),
      fetchBlueprintById: async () => ({}), fetchClassroomById: async () => ({}),
      buildTerraformDeploymentPayload: () => ({ vms: [{ vmid: 123 }] }),
      fetchClusterVmResources: async () => {
        if (scenario === 'unavailable') throw new Error('Proxmox unavailable');
        return [{ vmid: scenario === 'existing' ? 123 : 999 }];
      },
      initialDeploymentStatusForAction: () => 'destroying',
      updateDeploymentState: async data => { writes.push(data); return data; },
      queues: { terraform: { add: async (...args) => { jobs.push(args); return { id: 'job' }; } } },
      queueRetention: {}
    });
    const res = response();
    const request = { params: { id: 'lab', action: 'destroy' } };
    if (scenario === 'unavailable') await assert.rejects(handler(request, res), /Proxmox unavailable/);
    else {
      await handler(request, res);
      assert.equal(res.statusCode, { existing: 200, absent: 409, foreign: 403 }[scenario]);
    }
    assert.equal(jobs.length, scenario === 'existing' ? 1 : 0);
    assert.equal(writes.length, jobs.length);
    if (jobs.length) assert.equal(jobs[0][0], 'destroy');
  }
});

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
