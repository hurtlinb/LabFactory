const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('dashboard/public/app.js', 'utf8');
const code = source.slice(source.indexOf('function formatStorageBytes('), source.indexOf('async function loadTerraformSettings('));
function setup(fetchJson, isAdmin = true) {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', style: {}, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  } };
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const context = vm.createContext({ document, state: { isAdmin }, fetchJson, escapeHtml: escape, escapeHtmlAttr: escape });
  vm.runInContext(code, context);
  return { context, nodes };
}
test('storage panel renders filenames safely and reports zero, large and missing sizes', async () => {
  const { context, nodes } = setup(async () => ({
    storedFileCount: 2, totalBytes: 1073741824, availableBytes: 0, capacityBytes: 10737418240,
    files: [
      { id: '1', name: '<img src=x>', blueprintId: 'test', blueprintName: '<blueprint>', size: 1073741824, status: 'stored' },
      { id: '2', name: 'empty', blueprintName: null, size: 0, status: 'unreferenced' },
      { id: '3', name: 'missing', blueprintName: null, size: null, status: 'missing' }
    ]
  }));
  await context.loadUploadedFiles();
  assert.equal(nodes.get('uploadedFilesTotal').textContent, '1 GiB');
  assert.equal(nodes.get('uploadedFilesAvailable').textContent, '0 B');
  assert.equal(nodes.get('uploadedFilesCount').textContent, '2');
  assert.match(nodes.get('uploadedFilesBody').innerHTML, /&lt;img/);
  assert.doesNotMatch(nodes.get('uploadedFilesBody').innerHTML, /<img/);
  assert.match(nodes.get('uploadedFilesBody').innerHTML, /Missing from storage/);
  assert.equal(nodes.get('refreshUploadedFilesButton').disabled, false);
});
test('storage panel handles errors and never fetches for non-admins', async () => {
  const denied = setup(() => { throw new Error('must not fetch'); }, false);
  await denied.context.loadUploadedFiles();
  const failed = setup(async () => { throw new Error('unavailable'); });
  await failed.context.loadUploadedFiles();
  assert.match(failed.nodes.get('uploadedFilesStatus').textContent, /unavailable/);
  assert.equal(failed.nodes.get('refreshUploadedFilesButton').disabled, false);
});
