import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('dashboard/server.js', 'utf8');
const start = source.indexOf('const deriveDeploymentStatusFromResources =');
const end = source.indexOf('\n};', start) + 3;
const context = { Map, TRANSIENT_DEPLOYMENT_STATUSES: new Set(['queued', 'deploying', 'customizing', 'starting', 'stopping', 'destroying']) };
vm.runInNewContext(source.slice(start, end) + '\nthis.derive = deriveDeploymentStatusFromResources;', context);
test('explicit refresh recovers a failed stop into mixed, running or stopped', () => {
  for (const [states, expected] of [[['running','stopped'], 'mixed'], [['running','running'], 'running'], [['stopped','stopped'], 'stopped']]) {
    const resources = new Map(states.map((status, index) => [index + 1, { status }]));
    assert.equal(context.derive('failed', [1,2], resources), 'failed');
    assert.equal(context.derive('failed', [1,2], resources, { reconcileFailed: true }), expected);
  }
});
test('unavailable Proxmox does not clear failure, and active operations stay active', () => {
  assert.equal(context.derive('failed', [1], null, { reconcileFailed: true }), 'failed');
  assert.equal(context.derive('deploying', [1], new Map([[1, { status:'running' }]]), { reconcileFailed: true }), 'deploying');
});

const appSource = readFileSync('dashboard/public/app.js', 'utf8');
const actionStart = appSource.indexOf('function resolveLifecycleActions(');
vm.runInNewContext(appSource.slice(actionStart, appSource.indexOf('function updateVm(', actionStart)), Object.assign(context, {
  isDeploymentBusy: status => ['queued','deploying','customizing','starting','stopping','destroying'].includes(status)
}));
test('failed labs never offer Deploy when VMs exist or existence is unknown', () => {
  for (const exists of [true, null, undefined]) assert(!context.resolveLifecycleActions('failed', exists).items.some(item => item.action === 'deploy'));
  assert(context.resolveLifecycleActions('failed', false).items.some(item => item.action === 'deploy'));
  assert.deepEqual(Array.from(context.resolveLifecycleActions('mixed', true).items, item => item.action), ['start', 'stop']);
});

test('Refresh API accepts failed labs, persists live state and guards concurrent operations', async () => {
  const routeStart = source.lastIndexOf('app.post(', source.indexOf("'/api/lifecycle/deployments/refresh-state'"));
  const routeEnd = source.indexOf('app.post(', routeStart + 1);
  let handler;
  const writes = [];
  const deployment = { id: 'lab', status: 'failed', lastRunId: 'stop-run', blueprint: { id: 'bp' }, classroom: { id: 'room' } };
  const scope = {
    Map, app: { post: (...args) => { handler = args.at(-1); } },
    auth: { ROLE_GROUPS: { LABS: 'labs' }, requireRole: () => null }, wrapAsync: fn => fn,
    fetchDeploymentRows: async () => [deployment], mapDeployment: row => row,
    fetchClusterVmResources: async () => [{ vmid: 1, status: 'running' }, { vmid: 2, status: 'stopped' }],
    fetchBlueprintById: async () => ({}), fetchClassroomById: async () => ({}),
    buildTerraformDeploymentPayload: () => ({ vms: [{ vmid: 1 }, { vmid: 2 }] }),
    deriveDeploymentStatusFromResources: context.derive, deploymentBusyStatuses: context.TRANSIENT_DEPLOYMENT_STATUSES,
    dbPool: { query: async (...args) => writes.push(args) }, fetchDeploymentById: async () => ({ ...deployment, status: 'mixed' })
  };
  vm.runInNewContext(source.slice(routeStart, routeEnd), scope);
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await handler({ body: { deploymentId: 'lab' } }, res);
  assert.equal(writes.length, 1); assert.equal(writes[0][1][1], 'mixed');
  assert.match(writes[0][0], /status = \$4 AND last_run_id IS NOT DISTINCT FROM \$5/);
  assert.equal(res.body.deployments[0].status, 'mixed');
  deployment.status = 'stopping';
  await handler({ body: { deploymentId: 'lab' } }, res);
  assert.equal(res.statusCode, 409); assert.equal(writes.length, 1);
  deployment.status = 'failed'; scope.fetchClusterVmResources = async () => { throw Error('Proxmox unavailable'); };
  await assert.rejects(handler({ body: { deploymentId: 'lab' } }, res), /Proxmox unavailable/);
  assert.equal(writes.length, 1);
});
