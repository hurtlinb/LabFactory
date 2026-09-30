import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const source = readFileSync('dashboard/public/app.js', 'utf8');
function editor(fetchJson = async () => ({ variables: { share_root: 'C:\\Shares' } })) {
  const fields = Object.fromEntries(['blockName', 'yaml', 'variables', 'enabled', 'position'].map(name => [name, { value: '', checked: false, focus() {} }]));
  const cancel = {}, validate = {}, save = {};
  const form = { reset() {}, reportValidity: () => true, elements: { namedItem: name => fields[name] }, querySelectorAll: () => [cancel, validate, save] };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const message = {};
  const elements = { ansibleTasksDialog: dialog, ansibleTasksForm: form, ansibleTasksValidation: message, ansibleTasksValidate: validate, ansibleTasksCancel: cancel };
  const target = { id: 'vm', config: { ansibleTasks: [] } };
  const context = { state: { currentBlueprint: { vms: [target] } }, document: { getElementById: id => elements[id] },
    crypto: { randomUUID: () => 'new-id' }, isCurrentBlueprintLocked: () => false,
    updateVm: (_, update) => update(target), renderCanvas() {}, fetchJson, showMessage() {}, globalStatus: {} };
  vm.runInNewContext(source.slice(source.indexOf('function promptAnsibleTasks(')), context);
  return { context, target, fields, form, dialog, message, validate };
}

test('editor creates a disabled block, preserves variables and inserts at the chosen position', async () => {
  const e = editor();
  e.target.config.ansibleTasks = [{ id: 'existing', name: 'Existing' }];
  e.context.promptAnsibleTasks('vm');
  e.fields.blockName.value = 'New block';
  e.fields.enabled.checked = false;
  e.fields.position.value = 1;
  e.form.onsubmit({ preventDefault() {} });
  await setImmediate();
  assert.equal(e.target.config.ansibleTasks[0].id, 'new-id');
  assert.equal(e.target.config.ansibleTasks[0].enabled, false);
  assert.equal(e.target.config.ansibleTasks[0].variables.share_root, 'C:\\Shares');
  assert.equal(e.dialog.open, false);
});

test('editing keeps the block ID and reorders without duplication', async () => {
  const e = editor();
  e.target.config.ansibleTasks = [{ id: 'first', name: 'First', yaml: '- ansible.builtin.debug: {}' }, { id: 'second', name: 'Second' }];
  e.context.promptAnsibleTasks('vm', 'first');
  e.fields.position.value = 2;
  e.form.onsubmit({ preventDefault() {} });
  await setImmediate();
  assert.deepEqual(e.target.config.ansibleTasks.map(block => block.id), ['second', 'first']);
});

test('validation after editing is discarded and does not save the block', async () => {
  let finish;
  const e = editor(() => new Promise(resolve => { finish = resolve; }));
  e.context.promptAnsibleTasks('vm');
  e.validate.onclick();
  e.form.oninput();
  finish({ message: 'valid', collections: [], image: 'test' });
  await setImmediate();
  assert.match(e.message.textContent, /Changed/);
  assert.equal(e.target.config.ansibleTasks.length, 0);
});
