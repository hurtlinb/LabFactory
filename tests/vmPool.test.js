import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vmModule from 'node:vm';
import { z } from 'zod';
import { applyPoolAssignments, claimPoolVms, reconcileVmPools, proxmoxInventoryPool } from '../lib/vmPool.js';

const vm = (vmid = 10000) => ({ id: `vm-${vmid}`, vmid, templateId: 'model', cloneSource: '9000', fullClone: true });
const entry = (vmid = 900000, status = 'ready') => ({
  vmid, template_id: 'model', source_vmid: 9000, full_clone: true, node: 'pve', status, ownership_token: 'owned-token'
});

test('inventory uses the Proxmox resource pool corresponding to the environment', () => {
  assert.equal(proxmoxInventoryPool('development'), 'pool-dev');
  assert.equal(proxmoxInventoryPool('dev'), 'pool-dev');
  assert.equal(proxmoxInventoryPool('production'), 'pool');
  assert.equal(proxmoxInventoryPool(''), 'pool');
});

function claimDatabase({ entries = [], enabled = true, assignments = {} } = {}) {
  const queries = [];
  let saved = structuredClone(assignments);
  const client = {
    release() {},
    async query(sql, args) {
      queries.push(sql);
      if (sql.startsWith('SELECT pool_assignments')) return { rows: [{ pool_assignments: structuredClone(saved) }] };
      if (sql.startsWith('SELECT pool_enabled')) return { rows: [{ pool_enabled: enabled }] };
      if (sql.startsWith('SELECT p.*')) {
        assert.match(sql, /FOR UPDATE OF p SKIP LOCKED/);
        const found = entries.find(row => row.status === 'ready' && row.source_vmid === args[1] && row.full_clone === args[2]);
        return { rows: found ? [found] : [] };
      }
      if (sql.startsWith('UPDATE vm_pool')) entries.find(row => row.vmid === args[0]).status = 'assigned';
      if (sql.startsWith('UPDATE lab_deployments')) saved = JSON.parse(args[1]);
      return { rows: [] };
    }
  };
  return { connect: async () => client, queries, entries, assignments: () => saved };
}

test('an empty enabled pool waits instead of allowing a direct clone', async () => {
  const db = claimDatabase();
  const result = await claimPoolVms(db, 'lab', [vm()]);
  assert.deepEqual(result.waiting, ['vm-10000']);
  assert.equal(result.vms[0].vmid, 10000);
  assert(db.queries.includes('COMMIT'));
});

test('labs larger than the pool reserve incrementally and reuse reservations after restart', async () => {
  const db = claimDatabase({ entries: [entry()] });
  const first = await claimPoolVms(db, 'lab', [vm(), vm(10001)]);
  assert.deepEqual(first.waiting, ['vm-10001']);
  assert.equal(first.vms[0].vmid, 900000);
  db.entries.push(entry(900001));
  // Simulate restart with the original payload, before BullMQ data was saved.
  const second = await claimPoolVms(db, 'lab', [vm(), vm(10001)]);
  assert.deepEqual(second.waiting, []);
  assert.deepEqual(second.vms.map(row => row.vmid), [900000, 900001]);
  const third = await claimPoolVms(db, 'lab', second.vms);
  assert.deepEqual(third.vms, second.vms);
});

test('a claimed VM cannot be handed to a second lab', async () => {
  const entries = [entry()];
  await claimPoolVms(claimDatabase({ entries }), 'lab1', [vm()]);
  const result = await claimPoolVms(claimDatabase({ entries }), 'lab2', [vm()]);
  assert.equal(result.waiting.length, 1);
});

test('models without pools and existing lab VMs do not reserve pool VMs', async () => {
  const db = claimDatabase({ enabled: false, entries: [entry()] });
  assert.deepEqual((await claimPoolVms(db, 'lab', [vm()])).waiting, []);
  assert.equal(db.entries[0].status, 'ready');
  const enabledDb = claimDatabase({ entries: [entry()] });
  await claimPoolVms(enabledDb, 'lab', [vm()], new Set([10000]));
  assert.equal(enabledDb.entries[0].status, 'ready');
});

test('changed source or clone mode cannot consume stale inventory', async () => {
  const db = claimDatabase({ entries: [entry()] });
  assert.equal((await claimPoolVms(db, 'lab', [{ ...vm(), cloneSource: '9001' }])).waiting.length, 1);
  assert.equal((await claimPoolVms(db, 'lab', [{ ...vm(), fullClone: false }])).waiting.length, 1);
});

test('all lifecycle plans preserve assigned VM IDs and nodes without mutating the blueprint', () => {
  const original = [vm(), vm(10001)];
  const plan = applyPoolAssignments(original, { 10000: { vmid: 900000, node: 'pve' } });
  assert.equal(plan[0].poolNode, 'pve');
  assert.equal(plan[0].vmid, 900000);
  assert.equal(plan[1].vmid, 10001);
  assert.equal(original[0].vmid, 10000);
});

function reconciliation(entries, { enabled = true, size = 2, failure = false } = {}) {
  const events = [];
  const db = { async query(sql, args) {
    if (sql.startsWith('SELECT * FROM vm_templates')) return { rows: [{ id: 'model', pool_enabled: enabled, pool_size: size, proxmox_template_vmid: 9000, full_clone: true }] };
    if (sql.startsWith('SELECT * FROM vm_pool')) return { rows: entries.filter(row => row.status !== 'assigned') };
    events.push([sql, args]);
    return { rows: [] };
  } };
  const api = {
    finish: async row => { events.push(['finish', row.vmid]); if (failure) throw new Error('clone running'); },
    exists: async () => true,
    remove: async row => events.push(['remove', row.vmid]),
    create: async () => events.push(['create'])
  };
  return { db, api, events };
}

test('background replenishment replaces consumed VMs, excluding assigned inventory', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'assigned'), entry(900001)]);
  await reconcileVmPools(db, api);
  assert.equal(events.filter(([event]) => event === 'create').length, 1);
  assert(!events.some(([event]) => event === 'remove'));
});

test('disabling a pool removes only unused VMs', async () => {
  const { db, api, events } = reconciliation([entry(), entry(900001, 'assigned')], { enabled: false });
  await reconcileVmPools(db, api);
  assert.deepEqual(events.filter(([event]) => event === 'remove'), [['remove', 900000]]);
  assert(!events.some(([event]) => event === 'create'));
});

test('reducing a pool and changing a model purge excess or stale inventory', async () => {
  const { db, api, events } = reconciliation([entry(), entry(900001), { ...entry(900002), source_vmid: 8000 }], { size: 1 });
  await reconcileVmPools(db, api);
  assert.deepEqual(events.filter(([event]) => event === 'remove').map(([, id]) => id), [900001, 900002]);
});

test('interrupted creation is reconciled before becoming available', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'creating')], { size: 1 });
  await reconcileVmPools(db, api);
  assert.equal(events[0][0], 'finish');
  assert.match(events[1][0], /status = 'ready'/);
  assert(!events.some(([event]) => event === 'create'));
});

test('uncertain clone operations are retained and errors are exposed without overfilling', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'creating')], { size: 1, failure: true });
  await reconcileVmPools(db, api);
  assert(events.some(([event]) => event.startsWith('UPDATE vm_pool SET error')));
  assert(!events.some(([event]) => ['create', 'remove'].includes(event)));
});

test('model validation rejects enabled zero-capacity pools, fractions and excessive sizes', () => {
  const source = readFileSync('dashboard/server.js', 'utf8');
  const code = source.slice(source.indexOf('const templateSchema ='), source.indexOf('const blueprintVmSchema ='));
  const context = { z };
  vmModule.runInNewContext(`${code}\nthis.schema = templateSchema;`, context);
  const base = { name: 'Ubuntu', osType: 'ubuntu', proxmoxTemplateVmid: 9000, poolEnabled: true };
  for (const poolSize of [0, -1, 1.5, 1001]) {
    assert.equal(context.schema.safeParse({ ...base, poolSize }).success, false);
  }
  assert.equal(context.schema.safeParse({ ...base, poolSize: 5 }).success, true);
  assert.equal(context.schema.safeParse({ ...base, poolEnabled: false, poolSize: 0 }).success, true);
});

function proxmoxPoolApi({ name = 'labfactory-pool-900000', status = 'stopped', locked = false, taskStatus = 'stopped', description = 'LabFactory pool owned-token', environment = 'production' } = {}) {
  const source = readFileSync('workers/terraformWorker.js', 'utf8');
  const code = source.slice(source.indexOf('function poolApi('), source.indexOf('export function startTerraformWorker'));
  const requests = [];
  const resources = [
    { vmid: 900000, name, status, node: 'pve', template: 0 },
    { vmid: 9000, name: 'source', status: 'stopped', node: 'pve', template: 1 }
  ];
  const context = {
    URL,
    proxmoxInventoryPool: () => proxmoxInventoryPool(environment),
    requestJson: async request => {
      requests.push(request);
      if (request.url.pathname.endsWith('/clone')) {
        resources.push({ vmid: request.body.newid, name: request.body.name, status: 'stopped', node: 'pve', template: 0 });
      }
      return { data: 'task' };
    },
    proxmoxRequestOptions: () => ({}),
    fetchProxmoxVmResources: async () => resources,
    isProxmoxTemplate: value => value === 1,
    fetchVmConfig: async () => ({
      description,
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,link_down=0',
      ipconfig0: 'ip=10.0.0.2/24', cipassword: 'secret', ciuser: 'ubuntu',
      onboot: 1, ...(locked ? { lock: 'clone' } : {})
    }),
    waitForProxmoxTask: async () => {},
    fetchProxmoxTaskStatus: async () => ({ status: taskStatus }),
    dbPool: { query: async sql => ({
      rows: sql.includes('nextval') ? [{ vmid: 900001 }] : sql.includes('INSERT INTO vm_pool') ? [entry(900001, 'creating')] : []
    }) }
  };
  vmModule.runInNewContext(`${code}\nthis.api = poolApi({ proxmox_api_url: 'https://pve/api2/json' }, { assertHeld() {} });`, context);
  return { api: context.api, requests };
}

test('clone requests place inventory directly into the environment-specific Proxmox pool', async () => {
  for (const environment of ['development', 'production']) {
    const { api, requests } = proxmoxPoolApi({ environment });
    await api.create({ id: 'model', proxmox_template_vmid: 9000, full_clone: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].body.pool, environment === 'development' ? 'pool-dev' : 'pool');
    assert.equal(requests[0].body.description, 'LabFactory pool owned-token');
    assert.equal(requests[1].method, 'PUT');
  }
});

test('pool preparation disconnects networking, clears guest settings and never boots the VM', async () => {
  const { api, requests } = proxmoxPoolApi();
  await api.finish({ ...entry(), task_id: 'clone-task' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.match(requests[0].url.pathname, /\/config$/);
  assert.equal(requests[0].body.onboot, 0);
  assert.match(requests[0].body.net0, /link_down=1$/);
  assert.deepEqual(requests[0].body.delete.split(',').sort(), ['cipassword', 'ciuser', 'ipconfig0']);
});

test('cleanup refuses externally renamed, running, locked or still-cloning VMs', async () => {
  for (const options of [{ name: 'unrelated' }, { status: 'running' }, { locked: true }, { taskStatus: 'running' }, { description: 'other environment VM' }]) {
    const { api, requests } = proxmoxPoolApi(options);
    await assert.rejects(api.remove({ ...entry(), task_id: 'clone-task' }));
    assert.equal(requests.length, 0);
  }
});

test('cleanup deletes only an identified stopped pool VM after its clone task ends', async () => {
  const { api, requests } = proxmoxPoolApi();
  await api.remove({ ...entry(), task_id: 'clone-task' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.match(requests[0].url.pathname, /\/pve\/qemu\/900000$/);
});
