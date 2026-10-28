import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('dashboard/server.js', 'utf8');
const start = source.indexOf('// Poll Proxmox tasks separately');
const code = source.slice(start, source.indexOf("app.post(", start));
function setup(overrides = {}) {
  const routes = {};
  const calls = [];
  const context = {
    app: Object.fromEntries(['get', 'post'].map(method => [method, (path, role, handler) => { assert.equal(role, 'labs'); routes[method] = handler; }])),
    auth: { ROLE_GROUPS: { LABS: 'labs' }, requireRole: role => role }, wrapAsync: fn => fn,
    fetchDeploymentById: async () => ({ id: 'lab', status: 'running', blueprint: { id: 'bp' }, classroom: { id: 'room' } }),
    canManageDeployment: () => true, denyDeploymentManagement: res => res.status(403).json({ error: 'forbidden' }),
    deploymentBusyStatuses: new Set(['deploying', 'destroying', 'customizing']),
    fetchBlueprintById: async () => ({}), fetchClassroomById: async () => ({}),
    buildTerraformDeploymentPayload: () => ({ vms: [{ vmid: 101 }] }),
    fetchClusterVmResources: async () => [{ vmid: 101, type: 'qemu', node: 'pve' }],
    isQemuResource: vm => vm.type === 'qemu', readTerraformEnvSettings: () => ({}), assertRequiredTerraformEnvSettings: () => {},
    startVmSnapshotAction: async (_request, _resource, action) => { calls.push(action); return { task: 'task' }; },
    getVmSnapshotTask: async (_request, _resource, task) => ({ task, complete: false }),
    ...overrides
  };
  vm.runInNewContext(code, context);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, set() {}, json(body) { this.body = body; return this; } };
  const req = { params: { id: 'lab', vmid: '101' }, body: { action: 'create' }, query: { task: 'task' } };
  return { routes, calls, req, res };
}
test('snapshot POST accepts an async task, GET polls without starting a new one', async () => {
  const { routes, calls, req, res } = setup();
  await routes.post(req, res); assert.equal(res.statusCode, 202); assert.equal(res.body.task, 'task');
  await routes.get(req, res); assert.equal(res.body.complete, false); assert.deepEqual(calls, ['create']);
});
test('snapshot routes enforce ownership, deployment membership, busy state and resource existence', async () => {
  for (const [overrides, status] of [
    [{ canManageDeployment: () => false }, 403],
    [{ fetchDeploymentById: async () => null }, 404],
    [{ buildTerraformDeploymentPayload: () => ({ vms: [{ vmid: 999 }] }) }, 404],
    [{ deploymentBusyStatuses: new Set(['running']) }, 409],
    [{ fetchClusterVmResources: async () => [] }, 404],
    [{ fetchClusterVmResources: async () => { throw new Error('offline'); } }, 502]
  ]) {
    const { routes, calls, req, res } = setup(overrides);
    await routes.post(req, res); assert.equal(res.statusCode, status); assert.equal(calls.length, 0);
  }
});
test('invalid VM IDs are rejected; Proxmox conflicts are surfaced', async () => {
  const { routes, req, res } = setup(); req.params.vmid = 'invalid';
  await routes.post(req, res); assert.equal(res.statusCode, 400);
  const conflict = setup({ startVmSnapshotAction: async () => { throw Object.assign(new Error('already exists'), { statusCode: 409 }); } });
  await conflict.routes.post(conflict.req, conflict.res); assert.equal(conflict.res.statusCode, 409);
});
