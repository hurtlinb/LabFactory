import test from 'node:test';
import assert from 'node:assert/strict';
import { removeDestroyedDeployment } from '../lib/deploymentCleanup.js';

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
