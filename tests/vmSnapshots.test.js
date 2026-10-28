import test from 'node:test';
import assert from 'node:assert/strict';
import { getVmSnapshot, startVmSnapshotAction, getVmSnapshotTask } from '../lib/vmSnapshots.js';

const resource = { vmid: 101, node: 'pve', status: 'running' };
const task = 'UPID:pve:000001:000002:000003:qmsnapshot:101:root@pam:';
function setup({ exists = false, lock = null, taskStatus = { status: 'running' } } = {}) {
  const mutations = [];
  return { mutations, request: async (path, options) => {
    if (options?.method) { mutations.push({ path, ...options }); return { data: task }; }
    if (path.endsWith('/config')) return { data: { lock } };
    if (path.endsWith('/status')) return { data: taskStatus };
    return { data: [{ name: 'current' }, ...(exists ? [{ name: 'labfactory', snaptime: 123 }] : [])] };
  } };
}
test('current pseudo-snapshot is ignored and a single named disk snapshot is created', async () => {
  const { request, mutations } = setup();
  assert.equal((await getVmSnapshot(request, resource)).exists, false);
  assert.deepEqual(await startVmSnapshotAction(request, resource, 'create'), { task });
  assert.deepEqual(mutations, [{ path: 'nodes/pve/qemu/101/snapshot', method: 'POST', body: { snapname: 'labfactory', vmstate: 0 } }]);
});
test('existing snapshot cannot be overwritten, missing snapshot cannot be restored/deleted', async () => {
  for (const [action, exists] of [['create', true], ['delete', false], ['restore', false]]) {
    const { request, mutations } = setup({ exists });
    await assert.rejects(startVmSnapshotAction(request, resource, action), { statusCode: 409 });
    assert.equal(mutations.length, 0);
  }
});
test('locked VMs and invalid actions are rejected before any mutation', async () => {
  for (const action of ['create', 'delete', 'restore', 'unknown']) {
    const { request, mutations } = setup({ lock: 'snapshot' });
    await assert.rejects(startVmSnapshotAction(request, resource, action));
    assert.equal(mutations.length, 0);
  }
});
test('delete targets only labfactory; rollback preserves whether VM was running', async () => {
  const { request, mutations } = setup({ exists: true });
  await startVmSnapshotAction(request, resource, 'delete');
  await startVmSnapshotAction(request, resource, 'restore');
  await startVmSnapshotAction(request, { ...resource, status: 'stopped' }, 'restore');
  assert.deepEqual(mutations[0], { path: 'nodes/pve/qemu/101/snapshot/labfactory', method: 'DELETE' });
  assert.equal(mutations[1].path, 'nodes/pve/qemu/101/snapshot/labfactory/rollback');
  assert.equal(mutations[1].body.start, 1);
  assert.equal(mutations[2].body.start, 0);
});
test('task polling distinguishes running, success and failure, including missing exit status', async () => {
  for (const [taskStatus, complete, success] of [
    [{ status: 'running' }, false, false],
    [{ status: 'stopped', exitstatus: 'OK' }, true, true],
    [{ status: 'stopped', exitstatus: 'storage failure' }, true, false],
    [{ status: 'stopped' }, true, false]
  ]) {
    const { request } = setup({ taskStatus });
    const result = await getVmSnapshotTask(request, resource, task);
    assert.equal(result.complete, complete); assert.equal(result.success, success);
  }
});
test('tasks for other VMs or unrelated operations cannot be polled', async () => {
  for (const invalid of [undefined, task.replace(':101:', ':102:'), task.replace('qmsnapshot', 'qmstop')]) {
    await assert.rejects(getVmSnapshotTask(() => { throw new Error('must not request'); }, resource, invalid), { statusCode: 400 });
  }
});
test('inventory and mutation failures propagate without pretending success', async () => {
  await assert.rejects(getVmSnapshot(async () => ({ data: {} }), resource), /Invalid snapshot response/);
  const { request } = setup();
  await assert.rejects(startVmSnapshotAction(async (path, options) => options ? { data: null } : request(path), resource, 'create'), /task ID/);
});
