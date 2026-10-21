import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('workers/terraformWorker.js', 'utf8');
const helper = source.slice(source.indexOf('const runWithConcurrency ='), source.indexOf('const mergeVmTags ='));
const run = vm.runInNewContext(`${helper}\nrunWithConcurrency`);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('prepared Windows configuration overlaps, caps at ten and filters unrelated VMs', async () => {
  const start = source.indexOf('          const preparedWindows =');
  const end = source.indexOf('          if (replaceVmids.length', start);
  const gate = deferred();
  const started = [];
  const context = {
    scopedBlueprintVms: Array.from({ length: 15 }, (_, vmid) => ({ vmid, poolPrepared: vmid !== 13, osType: vmid === 14 ? 'linux' : 'windows11' })),
    windowsPoolOs: os => os === 'windows11', replaceVmids: [12],
    terraformParallelism: 20, abortController: new AbortController(),
    lease: { assertHeld() {} }, console: { log() {} }, deploymentLabel: 'test',
    merged: { vm_definitions: Array.from({ length: 15 }, (_, vmid) => ({ vmid })) },
    configurePreparedWindows: async (settings, item, definition) => {
      assert.equal(definition.vmid, item.vmid);
      started.push(item.vmid);
      await gate.promise;
    }
  };
  const work = vm.runInNewContext(`${helper}\n(async () => { ${source.slice(start, end)} })()`, context);
  assert.deepEqual(started, Array.from({ length: 10 }, (_, i) => i));
  gate.resolve();
  await work;
  assert.deepEqual(started, Array.from({ length: 12 }, (_, i) => i));
});

test('failure stops scheduling and waits for in-flight operations before rejecting', async () => {
  const gate = deferred(), started = [];
  const failure = new Error('guest failed');
  let settled = false;
  const work = run([1, 2, 3, 4], 2, async item => {
    started.push(item);
    if (item === 1) throw failure;
    await gate.promise;
  });
  const checked = assert.rejects(work, error => error === failure).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(started, [1, 2]);
  gate.resolve();
  await checked;
  assert.deepEqual(started, [1, 2]);
});

test('cancellation prevents queued operations and preserves the abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const started = [];
  await assert.rejects(run([1, 2, 3], 1, async item => {
    controller.signal.throwIfAborted();
    started.push(item);
    controller.abort(reason);
    controller.signal.throwIfAborted();
  }), error => error === reason);
  assert.deepEqual(started, [1]);
});
