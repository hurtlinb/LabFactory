import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptPoolVm } from '../lib/adoptPoolVm.js';

function fixture() {
  const calls = [];
  return { calls, args: {
    vm: { vmid: 900013, name: 'lab-course-PC01' },
    resource: { node: 'pve', pool: 'pool-dev' },
    config: { name: 'labfactory-pool-900013', description: 'LabFactory pool token', digest: 'digest' },
    token: 'token', targetPool: 'labs-dev', inventoryPool: 'pool-dev',
    assertHeld() {}, request: async (route, body) => calls.push({ route, body })
  } };
}

test('adoption transfers the VM to the lab pool and applies the lab name without changing its identity or guest', async () => {
  const { args, calls } = fixture();
  await adoptPoolVm(args);
  assert.deepEqual(calls, [
    { route: 'pools/labs-dev', body: { vms: '900013', 'allow-move': 1 } },
    { route: 'nodes/pve/qemu/900013/config', body: { name: 'lab-course-PC01', digest: 'digest' } }
  ]);
});

test('retry after pool transfer completes the rename and a completed adoption is a no-op', async () => {
  const { args, calls } = fixture();
  args.resource.pool = 'labs-dev';
  await adoptPoolVm(args);
  assert.equal(calls.length, 1);
  args.config.name = args.vm.name;
  await adoptPoolVm(args);
  assert.equal(calls.length, 1);
});

test('labs configured without a pool still leave the inventory pool', async () => {
  const { args, calls } = fixture();
  args.targetPool = '';
  await adoptPoolVm(args);
  assert.deepEqual(calls[0], { route: 'pools/pool-dev', body: { vms: '900013', delete: 1 } });
});

test('ownership mismatches, external transfers and lost locks prevent adoption', async () => {
  for (const mutate of [a => { a.token = 'other'; }, a => { a.resource.pool = 'other-lab'; },
    a => { a.config.lock = 'clone'; }, a => { a.config.template = 1; },
    a => { a.assertHeld = () => { throw new Error('Lock lost'); }; }]) {
    const { args, calls } = fixture();
    mutate(args);
    await assert.rejects(adoptPoolVm(args));
    assert.equal(calls.length, 0);
  }
});

test('a refused pool transfer stops adoption before renaming', async () => {
  const { args } = fixture();
  let calls = 0;
  args.request = async () => { calls++; throw new Error('Permission denied'); };
  await assert.rejects(adoptPoolVm(args), /Permission denied/);
  assert.equal(calls, 1);
});
