import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../workers/terraformWorker.js', import.meta.url), 'utf8');
function harness(request) {
  let now = 0, round = 0;
  const ready = [], failed = [], calls = [];
  const context = {
    URL, Date: { now: () => now },
    VM_POWER_STATE_WAIT_TIMEOUT_MS: 20, VM_POWER_STATE_WAIT_RETRY_MS: 5,
    normalizeVmids: ids => [...new Set(ids.map(Number))],
    resolveVmNodesByVmid: async (_env, ids) => new Map(ids.map(id => [id, ++round > 1 ? 'pve2' : 'pve1'])),
    runWithConcurrency: async (ids, _limit, fn) => { for (const id of ids) await fn(id); },
    proxmoxRequestOptions: () => ({ headers: { Authorization: 'test-token' } }),
    formatProxmoxError: error => error.message,
    requestJson: async options => { calls.push(options); return request(options, calls.length); },
    abortableSleep: async ms => { now += ms; }
  };
  const wait = vm.runInNewContext(source.slice(source.indexOf('const waitForStartedGuestAgents ='), source.indexOf('const waitForGuestReadiness =')) + '\nwaitForStartedGuestAgents;', context);
  return {
    ready, failed, calls,
    run: (signal = new AbortController().signal) => wait({
      envSettings: { proxmox_api_url: 'https://pve/api2/json' }, vmids: [101, 102], signal, concurrency: 2,
      readinessReporter: { markReady: async id => ready.push(id), markFailed: async id => failed.push(id) }
    })
  };
}

test('start checks every VM through the agent without IP or guest credentials; retries on the current node', async () => {
  const h = harness(async (options, attempt) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'test-token');
    assert.match(options.url.pathname, /^\/api2\/json\/nodes\/pve[12]\/qemu\/10[12]\/agent\/ping$/);
    if (attempt === 1) throw new Error('guest agent is not running');
    return { data: null }; // Proxmox ping success has no truthy result.
  });
  await h.run();
  assert.deepEqual(h.ready, [102, 101]);
  assert.deepEqual(h.failed, []);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[2].url.pathname, /nodes\/pve2\/qemu\/101/);
});

test('an unavailable agent fails the start and identifies only unready VMs', async () => {
  const h = harness(async options => {
    if (options.url.pathname.includes('/101/')) throw new Error('guest agent is not running');
    return { data: null };
  });
  await assert.rejects(h.run(), /Timed out waiting for QEMU Guest Agent: VM 101/);
  assert.deepEqual(h.ready, [102]);
  assert.deepEqual(h.failed, [101]);
});

test('cancellation during agent request never marks a VM ready', async () => {
  const controller = new AbortController();
  const h = harness(async options => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error('cancelled'));
    throw controller.signal.reason;
  });
  await assert.rejects(h.run(controller.signal), /cancelled/);
  assert.deepEqual(h.ready, []);
  assert.equal(h.calls.length, 1);
});
