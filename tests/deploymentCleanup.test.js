import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { removeDestroyedDeployment } from '../lib/deploymentCleanup.js';

test('destruction stays in progress while storage cleanup runs after the last VM disappears', () => {
  const source = readFileSync(new URL('../dashboard/server.js', import.meta.url), 'utf8');
  const statuses = source.slice(source.indexOf('const TRANSIENT_DEPLOYMENT_STATUSES ='), source.indexOf('const resetTransientLifecycleStates ='));
  const derive = source.slice(source.indexOf('const deriveDeploymentStatusFromResources ='), source.indexOf('const persistBlueprint ='));
  const resolve = runInNewContext(`${statuses}\n${derive}\nderiveDeploymentStatusFromResources`, { Map });
  for (const reconcileTransient of [false, true]) {
    for (const resources of [new Map([[101, { status: 'stopped' }]]), new Map()]) {
      assert.equal(resolve('destroying', [101, 102], resources, { reconcileTransient }), 'destroying');
    }
    assert.equal(resolve('failed', [101, 102], new Map(), { reconcileTransient }), 'failed');
  }
});

test('successful destruction deletes only the matching destroy run', async () => {
  const calls = [];
  const db = { query: async (sql, args) => { calls.push({ sql, args }); return { rowCount: 1 }; } };
  assert.equal(await removeDestroyedDeployment(db, 'lab', 'run'), true);
  assert.deepEqual(calls[0].args, ['lab', 'run']);
  assert.match(calls[0].sql, /DELETE FROM lab_deployments/);
  assert.match(calls[0].sql, /last_run_id = \$2/);
  assert.match(calls[0].sql, /status = 'destroying' AND last_action = 'destroy'/);
});

test('stale completion cannot delete a newer deployment run', async () => {
  assert.equal(await removeDestroyedDeployment({ query: async () => ({ rowCount: 0 }) }, 'lab', 'old-run'), false);
});

test('missing run identity and database failures cannot be reported as cleanup success', async () => {
  const db = { query: async () => { throw new Error('Database unavailable'); } };
  await assert.rejects(removeDestroyedDeployment(db, 'lab', null), /IDs are required/);
  await assert.rejects(removeDestroyedDeployment(db, 'lab', 'run'), /Database unavailable/);
});
