import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessLimiter, readinessConcurrency } from '../lib/readinessConcurrency.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('88 probes across two labs share four slots and preserve FIFO order', async () => {
  const limit = createReadinessLimiter(4);
  let active = 0;
  let peak = 0;
  const order = [];
  const probes = Array.from({ length: 2 }, (_, lab) =>
    Array.from({ length: 44 }, (_, vm) => limit(async () => {
      order.push(lab * 44 + vm);
      peak = Math.max(peak, ++active);
      await tick();
      active--;
    })));
  await Promise.all(probes.flat());
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(order, Array.from({ length: 88 }, (_, i) => i));
});

test('failed probes release their slots', async () => {
  const limit = createReadinessLimiter(1);
  const first = limit(() => { throw new Error('unreachable'); });
  const next = limit(() => 'ready');
  await assert.rejects(first, /unreachable/);
  assert.equal(await next, 'ready');
});

test('aborted queued probes never start and do not block other labs', async () => {
  const limit = createReadinessLimiter(1);
  let release;
  const first = limit(() => new Promise(resolve => { release = resolve; }));
  await tick();
  const controller = new AbortController();
  let started = false;
  const cancelled = limit(() => { started = true; }, controller.signal);
  const rejected = assert.rejects(cancelled, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejected;
  const next = limit(() => 'ready');
  release();
  await first;
  assert.equal(await next, 'ready');
  assert.equal(started, false);
});

test('pre-aborted probes do not run', async () => {
  const limit = createReadinessLimiter(1);
  await assert.rejects(limit(() => assert.fail('must not start'), AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  assert.equal(await limit(() => 'ready'), 'ready');
});

test('configuration defaults to four and accepts only integers from one to eight', () => {
  for (const value of [undefined, '', '0', '-1', '9', '1.5', 'invalid']) assert.equal(readinessConcurrency(value), 4);
  assert.equal(readinessConcurrency('2'), 2);
  assert.equal(readinessConcurrency('8'), 8);
});
