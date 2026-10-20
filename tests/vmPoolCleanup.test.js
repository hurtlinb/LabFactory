import test from 'node:test';
import assert from 'node:assert/strict';
import { listVmPoolCleanup, emptyVmPool } from '../lib/vmPoolCleanup.js';

function fixture({ rows = [], protectedIds = [], members, configs = {} } = {}) {
  const removed = [], stopped = [], queries = [], poolsRead = [];
  let currentMembers = members ?? [{ type: 'qemu', vmid: 900000, node: 'pve', name: 'orphan' }];
  const context = {
    pool: 'pool-dev', protectedVmids: new Set(protectedIds), assertHeld() {},
    db: { async query(sql, args) { queries.push([sql, args]); return { rows }; } },
    api: {
      pools: async () => [{ poolid: 'pool-dev' }, { poolid: 'pool' }],
      members: async pool => { poolsRead.push(pool); return currentMembers; },
      resources: async () => currentMembers,
      config: async (_node, id) => ({ name: 'orphan', digest: `digest-${id}`, ...configs[id] }),
      task: async () => ({ status: 'stopped' }),
      status: async () => ({ status: 'running' }),
      stop: async (_node, id) => { stopped.push(id); },
      remove: async (_node, id) => { removed.push(id); }
    }
  };
  return { context, removed, stopped, queries, poolsRead, setMembers: value => { currentMembers = value; } };
}

test('preview comes from Proxmox and includes VMs absent from the database, only in the environment pool', async () => {
  const f = fixture();
  const preview = await listVmPoolCleanup(f.context);
  assert.equal(preview.entries[0].vmid, 900000);
  assert.equal(preview.entries[0].reason, null);
  assert.deepEqual(f.poolsRead, ['pool-dev']);
  assert.deepEqual(f.removed, []);
});

test('cleanup stops a confirmed orphan before deletion, then clears its inventory record', async () => {
  const f = fixture();
  const { entries } = await listVmPoolCleanup(f.context);
  const result = await emptyVmPool({ ...f.context, selected: entries });
  assert.deepEqual(f.stopped, [900000]);
  assert.deepEqual(f.removed, [900000]);
  assert.equal(result.deleted.length, 1);
  assert(f.queries.some(([sql]) => sql.startsWith('DELETE FROM vm_pool') && sql.includes("status <> 'assigned'")));
  assert(f.poolsRead.every(pool => pool === 'pool-dev'));
});

test('lab reservations, deployed VM plans, templates and locked VMs are protected', async () => {
  for (const options of [
    { rows: [{ vmid: 900000, status: 'assigned', deployment_id: 'lab' }] },
    { protectedIds: [900000] },
    { configs: { 900000: { template: 1 } } },
    { configs: { 900000: { lock: 'clone' } } }
  ]) {
    const f = fixture(options);
    const { entries } = await listVmPoolCleanup(f.context);
    assert(entries[0].reason);
    const result = await emptyVmPool({ ...f.context, selected: entries });
    assert.equal(result.skipped.length, 1);
    assert.equal(f.stopped.length + f.removed.length, 0);
  }
});

test('changed identity and VMIDs outside the preview cannot be deleted', async () => {
  const f = fixture();
  const { entries } = await listVmPoolCleanup(f.context);
  const selected = [{ ...entries[0], digest: 'old-digest' }, { ...entries[0], vmid: 999999 }];
  const result = await emptyVmPool({ ...f.context, selected });
  assert.equal(result.skipped.length, 2);
  assert.equal(f.removed.length, 0);
});

test('a VM moved out of the pool during shutdown is not deleted', async () => {
  const f = fixture();
  const { entries } = await listVmPoolCleanup(f.context);
  f.context.api.stop = async () => f.setMembers([]);
  const result = await emptyVmPool({ ...f.context, selected: entries });
  assert.equal(result.errors.length, 1);
  assert.equal(f.removed.length, 0);
});

test('a failed Proxmox deletion preserves its database record and reports the failure', async () => {
  const f = fixture();
  const { entries } = await listVmPoolCleanup(f.context);
  f.context.api.remove = async () => { throw new Error('Storage unavailable'); };
  const result = await emptyVmPool({ ...f.context, selected: entries });
  assert.match(result.errors[0].reason, /Storage unavailable/);
  assert(!f.queries.some(([sql]) => sql.startsWith('DELETE')));
});

test('missing VM records are cleared without touching Proxmox; uncertain clones are retained', async () => {
  const f = fixture({ members: [], rows: [
    { vmid: 900000, node: 'pve', status: 'error', ownership_token: 'one' },
    { vmid: 900001, node: 'pve', status: 'creating', ownership_token: 'two' }
  ] });
  const { entries } = await listVmPoolCleanup(f.context);
  const result = await emptyVmPool({ ...f.context, selected: entries });
  assert.deepEqual(result.deleted, [{ vmid: 900000, kind: 'record' }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(f.removed.length + f.stopped.length, 0);
});

test('loss of the shared deployment lock prevents destructive operations', async () => {
  const f = fixture();
  const { entries } = await listVmPoolCleanup(f.context);
  const result = await emptyVmPool({ ...f.context, selected: entries, assertHeld() { throw new Error('Lock lost'); } });
  assert.equal(result.errors.length, 1);
  assert.equal(f.removed.length + f.stopped.length, 0);
});
