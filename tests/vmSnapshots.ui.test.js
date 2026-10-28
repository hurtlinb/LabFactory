import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('dashboard/public/app.js', 'utf8');
function setup(overrides = {}) {
  const selection = { selected: new Set(), payload: {} };
  const calls = [];
  const context = {
    getDeploymentVmSelection: () => selection, renderVmActionIcon: () => '<svg></svg>',
    escapeHtml: String, escapeHtmlAttr: String, getOsLabel: String,
    state: { activeDeploymentDetailsId: 'lab' }, preserveDetailView: fn => fn(), renderDeploymentVmDetails: () => {},
    confirmAction: async () => true, refreshOpenDeploymentDetails: async () => {},
    fetchJson: async (url, options) => { calls.push({ url, options }); return options ? { task: 'upid' } : { complete: true, success: true }; },
    setTimeout: fn => fn(), ...overrides
  };
  vm.runInNewContext(source.slice(source.indexOf('const vmSnapshotDescriptions ='), source.indexOf('async function redeployDeploymentWorkstation(')), context);
  return { context, selection, calls };
}
test('rows offer creation only without a snapshot and restore/delete only with one', () => {
  const { context } = setup();
  for (const exists of [true, false]) {
    const html = context.renderDeploymentVmRows([{ vmid: 101, snapshot: { exists } }], 'lab', false, false, false, true);
    assert.equal(html.includes('data-snapshot-action="create"'), !exists);
    assert.equal(html.includes('data-snapshot-action="restore"'), exists);
    assert.equal(html.includes('data-snapshot-action="delete"'), exists);
  }
});
test('unavailable status never offers creation and locked/unauthorized VMs disable actions', () => {
  const { context } = setup();
  const row = snapshot => [{ vmid: 101, snapshot }];
  assert(!context.renderDeploymentVmRows(row({ error: 'offline' }), 'lab', false, false, false, true).includes('data-snapshot-action'));
  assert(context.renderDeploymentVmRows(row({ exists: false, locked: true }), 'lab', false, false, false, true).includes('disabled'));
  assert(context.renderDeploymentVmRows(row({ exists: false }), 'lab').includes('disabled'));
});
test('snapshot column displays local date/time and icon actions are in the actions cell', () => {
  const { context } = setup();
  const createdAt = 1793192400;
  const html = context.renderDeploymentVmRows([{ vmid: 101, snapshot: { exists: true, createdAt } }], 'lab', false, false, false, true);
  const cell = html.match(/<td class="vm-snapshot-cell">([\s\S]*?)<\/td>/)[1];
  assert(cell.includes(new Date(createdAt * 1000).toLocaleString()));
  assert(!cell.includes('<button'));
  assert.match(html, /class="icon-btn vm-snapshot-button"/);
  assert.match(html, /aria-label="Restore snapshot labfactory"><svg>/);
});
test('cancel sends no request, accepted operations poll and show completion', async () => {
  const cancelled = setup({ confirmAction: async () => false });
  await cancelled.context.runVmSnapshotAction('lab', '101', 'restore'); assert.equal(cancelled.calls.length, 0);
  const { context, selection, calls } = setup();
  await context.runVmSnapshotAction('lab', '101', 'create');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].options.body).action, 'create');
  assert.equal(selection.snapshotOperations.get('101').message, 'Snapshot created.');
  assert.equal(selection.snapshotOperations.get('101').running, false);
});
test('failed tasks are displayed and duplicate pending actions do not submit', async () => {
  const { context, selection, calls } = setup({ fetchJson: async (_url, options) => options ? { task: 'upid' } : { complete: true, success: false, error: 'Disk failure' } });
  await context.runVmSnapshotAction('lab', '101', 'delete');
  assert.match(selection.snapshotOperations.get('101').message, /Disk failure/);
  selection.snapshotOperations.set('101', { running: true });
  await context.runVmSnapshotAction('lab', '101', 'create'); assert.equal(calls.length, 0);
});
