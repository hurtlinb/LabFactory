const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('dashboard/public/app.js', 'utf8');
const helpers = source.slice(source.indexOf('const deploymentVmSelections ='), source.indexOf('function renderDeploymentVmRows('));
function setup(fetchJson = async () => ({ days: 35, ip: '10.0.0.1' })) {
  const context = {
    state: { activeDeploymentDetailsId: 'lab' },
    deploymentVmDetailsList: { querySelector: () => null, querySelectorAll: () => [] },
    escapeHtml: value => String(value).replaceAll('<', '&lt;'),
    fetchJson, confirm: () => true, renderDeploymentVmDetails: () => {}
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  const selection = context.getDeploymentVmSelection('lab');
  selection.payload = { deployment: { id: 'lab', status: 'mixed' }, vms: [] };
  return { context, selection };
}
function machine(vmid, overrides = {}) {
  return { vmid, name: 'VM ' + vmid, osType: 'windows11', proxmoxStatus: 'running', ipAddress: '10.0.0.1', ...overrides };
}
test('eligibility covers mixed labs, stopped VMs, DHCP and Windows-only pause', () => {
  const { context } = setup();
  const reason = context.getVmActionUnavailableReason;
  for (const action of ['reset-ip', 'reset-password', 'pause-updates']) {
    assert.equal(reason(machine(1), { status: 'mixed' }, action), '');
    assert(reason(machine(1, { proxmoxStatus: 'stopped' }), { status: 'running' }, action));
    assert(reason(machine(1), { status: 'deploying' }, action));
  }
  assert(reason(machine(1, { ipAddress: 'dhcp' }), { status: 'running' }, 'reset-ip'));
  assert(reason(machine(1, { osType: 'ubuntu' }), { status: 'running' }, 'pause-updates'));
  assert.equal(reason(machine(1, { osType: 'ubuntu' }), { status: 'running' }, 'reset-password'), '');
});
test('batch sends selected eligible VMs only, limits concurrency and survives errors', async () => {
  let active = 0, maximum = 0;
  const calls = [];
  const { context, selection } = setup(async url => {
    calls.push(url); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (url.includes('/vms/2/')) throw new Error('Guest agent unavailable');
    return { days: 35 };
  });
  selection.payload.vms = [1,2,3,4,5].map(id => machine(id)).concat(machine(6, { osType: 'ubuntu' }), machine(7, { proxmoxStatus: 'stopped' }), machine(8));
  selection.selected = new Set(['1','2','3','4','5','6','7']);
  const pending = context.runVmBulkAction('lab', 'pause-updates');
  await context.runVmBulkAction('lab', 'pause-updates'); // duplicate clicks must not enqueue another batch
  await pending;
  assert.equal(calls.length, 5); assert.equal(maximum, 3); assert.equal(selection.running, false);
  assert.equal(selection.results.filter(r => r.status === 'success').length, 4);
  assert.equal(selection.results.filter(r => r.status === 'error').length, 1);
  assert.equal(selection.results.filter(r => r.status === 'skipped').length, 2);
  assert.equal(selection.results.find(r => r.vmid === '2').message, 'Guest agent unavailable');
  assert.equal(selection.selected.size, 7);
});
test('reset actions ask once and cancellation sends no requests', async () => {
  let requests = 0, confirmations = 0;
  const { context, selection } = setup(async () => { requests++; return { ip: '10.0.0.1' }; });
  selection.payload.vms = [machine(1),machine(2)]; selection.selected = new Set(['1','2']);
  context.confirm = () => { confirmations++; return false; };
  await context.runVmBulkAction('lab', 'reset-password');
  assert.equal(requests, 0); assert.equal(selection.running, false);
  context.confirm = () => { confirmations++; return true; };
  await context.runVmBulkAction('lab', 'reset-ip');
  assert.equal(confirmations, 2); assert.equal(requests, 2);
});
test('empty selection and incompatible selection send no requests', async () => {
  const { context, selection } = setup(async () => { throw new Error('Unexpected request'); });
  await context.runVmBulkAction('lab', 'pause-updates');
  selection.payload.vms = [machine(1, { osType: 'ubuntu' })]; selection.selected.add('1');
  await context.runVmBulkAction('lab', 'pause-updates');
  assert.equal(selection.results.length, 0);
});
test('selections and results are isolated by lab and retained when reopened', () => {
  const { context, selection } = setup(); selection.selected.add('1');
  assert.equal(context.getDeploymentVmSelection('other').selected.size, 0);
  assert.equal(context.getDeploymentVmSelection('lab'), selection);
  selection.action = 'reset-ip'; selection.results = [{ name: '<script>', vmid: '1', status: 'error', message: '<unsafe>' }];
  const html = context.renderVmBulkResults(selection);
  assert(!html.includes('<script>')); assert(html.includes('&lt;unsafe>'));
});

test('select all, partial selection and refresh preserve row selection and counts', () => {
  const { context, selection } = setup();
  const control = dataset => ({ dataset, setAttribute(name, value) { this[name] = value; }, addEventListener(event, handler) { this[event] = handler; } });
  const all = control({}), count = {}, feedback = {};
  const rows = [control({ vmid: '1' }), control({ vmid: '2' })];
  const buttons = ['reset-ip', 'reset-password', 'pause-updates'].map(action => control({ vmBulkAction: action }));
  context.deploymentVmDetailsList = {
    innerHTML: '',
    querySelector: selector => ({ '.vm-select-all': all, '.vm-selection-count': count, '.vm-bulk-feedback': feedback })[selector],
    querySelectorAll: selector => selector === '.vm-select' ? rows : selector === '[data-vm-bulk-action]' ? buttons : []
  };
  context.escapeHtmlAttr = String; context.getOsLabel = String;
  context.getDeploymentWorkstationNumber = () => '1'; context.isDeploymentBusy = () => false;
  vm.runInContext(source.slice(source.indexOf('function renderDeploymentVmRows('), source.indexOf('async function redeployDeploymentWorkstation(')), context);
  vm.runInContext(source.slice(source.indexOf('function renderDeploymentVmDetails('), source.indexOf('async function openDeploymentDetails(')), context);
  const payload = { deployment: { id: 'lab', status: 'mixed' }, vms: [machine(1), machine(2, { osType: 'ubuntu' })] };
  context.renderDeploymentVmDetails(payload);
  all.change({ target: { checked: true } });
  assert.equal(selection.selected.size, 2); assert.equal(count.textContent, '2 / 2 selected');
  assert.equal(buttons[2]['aria-label'], 'Pause updates: 1 compatible VM(s); 1 will be skipped');
  rows[1].checked = false; rows[1].change();
  assert.equal(all.indeterminate, true);
  context.renderDeploymentVmDetails(payload);
  assert(context.deploymentVmDetailsList.innerHTML.includes("checked />"));
  assert.equal(selection.selected.size, 1);
  context.renderDeploymentVmDetails({ ...payload, vms: [payload.vms[1]] });
  assert.equal(selection.selected.size, 0); assert(buttons.every(button => button.disabled));
});
