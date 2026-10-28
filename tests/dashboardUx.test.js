import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as helpers from '../dashboard/public/ux.js';

const html = readFileSync('dashboard/public/index.html', 'utf8');
const source = readFileSync('dashboard/public/app.js', 'utf8')
  .replace(/^import .*from '.\/ux.js';\s*/, '')
  .replace(/bootstrap\(\)\.catch\(error => \{[\s\S]*?\n\}\);/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('blueprint palette switches compact tabs and supports keyboard navigation', async t => {
  const { api, document, w } = setup(t);
  await api.bootstrap();
  const vmTab = document.getElementById('paletteVmTab');
  const customizationTab = document.getElementById('paletteCustomizationTab');
  assert.equal(document.querySelectorAll('[data-palette-tab]').length, 2);
  assert.equal(document.getElementById('paletteVmPanel').hidden, false);
  assert.equal(document.getElementById('paletteCustomizationPanel').hidden, true);
  customizationTab.click();
  assert.equal(customizationTab.getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('paletteVmPanel').hidden, true);
  assert.equal(document.getElementById('paletteSearch'), null);
  assert.equal(document.getElementById('paletteOs'), null);
  assert.equal(document.querySelectorAll('.vm-lib-cust').length, 8);
  assert(vmTab.querySelector('svg'));
  assert(customizationTab.querySelector('svg'));
  customizationTab.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  assert.equal(document.activeElement, vmTab);
  assert.equal(document.getElementById('paletteVmPanel').hidden, false);
});
const blueprint = { id: 'bp', name: 'Network lab', description: '', course: { id: 'course', courseNumber: 101 }, vms: [{ id: 'vm', name: 'Server', template: { id: 'template' }, config: {} }], updatedAt: new Date().toISOString() };
function setup(t) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, helpers);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function (value = '') { this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close')); };
  const requests = [];
  w.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    const data = url === '/api/app-info' ? { auth: { enabled: false } } :
      url === '/api/blueprints/bp' ? blueprint :
      url === '/api/blueprints' ? [{ ...blueprint, vmCount: 1 }] :
      url === '/api/templates' ? [{ id: 'template', name: 'Ubuntu', osType: 'ubuntu', proxmoxTemplateVmid: 9000 }] :
      url === '/api/courses' ? [{ id: 'course', courseNumber: 101 }] :
      ['/api/health', '/api/timezones'].includes(url) ? {} : [];
    return { ok: true, json: async () => data };
  };
  w.setInterval = () => 1;
  w.eval(source + '\nwindow.uxTest = { state, renderDashboard, bootstrap, loadBlueprint, isBlueprintDirty, saveBlueprint, showMessage, renderLifecycleLabs, renderDeploymentVmDetails, preserveDetailView, renderBlueprintList, setActiveView, readRoute, markBlueprintSaved, promptDeploymentConflict, openDeploymentDetails };');
  return { w, api: w.uxTest, requests, document: w.document };
}

test('network preview and status labels describe real operations', () => {
  assert.equal(helpers.labStatusLabel('mixed'), 'Partially running');
  assert.equal(helpers.labStatusLabel('deployed'), 'Ready');
  assert.deepEqual(helpers.classroomPreview({ workstationCount: 2, startingVlan: 200, startingSubnet: '10.0.200.0', networkGateway: '10.0.200.1' })[1],
    { workstation: 2, vlan: 201, subnet: '10.0.201.0/24', gateway: '10.0.201.1' });
  assert.equal(helpers.classroomPreview({ workstationCount: 20, startingVlan: 200, startingSubnet: '10.0.250.0', networkGateway: '10.0.250.1' }), null);
  assert(helpers.matchesSearch('lab 101', 'Network lab', 101));
});

test('dashboard bootstraps all views, and edits are protected when replacing a blueprint', async t => {
  const { api, document, w } = setup(t);
  await api.bootstrap();
  assert(document.getElementById('globalStatus').hidden);
  await api.setActiveView('blueprint');
  await api.loadBlueprint('bp');
  assert.equal(api.isBlueprintDirty(), false);
  const course = document.getElementById('blueprintCourseId');
  assert.equal(document.querySelectorAll('#blueprintCourseId').length, 1);
  assert.equal(course.form.id, 'blueprintForm');
  assert(course.closest('.blueprint-details-fields'));
  assert.equal(course.closest('.page').hidden, false);
  assert.equal(course.value, 'course');
  assert.equal(course.required, true);
  course.value = '';
  course.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(api.state.currentBlueprint.courseId, '');
  assert.equal(api.isBlueprintDirty(), true);
  course.value = 'course';
  course.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(api.isBlueprintDirty(), false);
  const input = document.getElementById('blueprintName');
  input.value = 'Edited'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(api.isBlueprintDirty(), true);
  document.getElementById('newBlueprintButton').click();
  await tick();
  const confirmation = document.querySelector('.confirmation-dialog');
  assert(confirmation.open); confirmation.close('cancel'); await tick();
  assert.equal(api.state.currentBlueprint.name, 'Edited');
  assert.equal(document.querySelector('.confirmation-dialog'), null);
});

test('destructive lab action waits for confirmation and cancellation sends no request', async t => {
  const { api, document, requests } = setup(t);
  await api.bootstrap();
  api.state.deployments = [{ id: 'lab', deploymentNumber: 1, status: 'stopped', totalVmCount: 24, blueprint: { id: 'bp', name: 'Network lab' }, classroom: { id: 'room', name: 'A203' } }];
  api.renderLifecycleLabs();
  document.querySelector('[data-action="destroy"]').click(); await tick();
  assert.match(document.querySelector('#confirmationMessage').textContent, /24 VMs/);
  document.querySelector('.confirmation-dialog').close('cancel'); await tick();
  assert(!requests.some(request => request.url.endsWith('/destroy')));
});

test('detail refresh preserves expanded task output and focused VM selection', async t => {
  const { api, document } = setup(t); await api.bootstrap();
  const payload = { deployment: { id: 'lab', status: 'running' }, vms: [{ vmid: 1, name: 'VM', osType: 'ubuntu', proxmoxStatus: 'running', customization: { taskResults: { task: { name: 'Install', status: 'succeeded', output: 'Done' } } } }] };
  api.renderDeploymentVmDetails(payload);
  const root = document.getElementById('deploymentVmDetailsList');
  root.querySelector('details').open = true;
  root.querySelector('.vm-select').focus();
  payload.vms[0].customization.taskResults.task.output = 'Updated output';
  api.preserveDetailView(() => api.renderDeploymentVmDetails(payload));
  assert(root.querySelector('details').open);
  assert.equal(document.activeElement.dataset.vmid, '1');
  assert.match(root.querySelector('pre').textContent, /Updated output/);
});

test('workstation cards group every VM and preserve per-VM selection, actions and expanded tasks', async t => {
  const { api, document, w } = setup(t); await api.bootstrap();
  api.state.activeDeploymentDetailsId = 'lab';
  const machine = (vmid, workstationNumber, osType) => ({
    vmid, workstationNumber, name: `VM ${vmid}`, osType, proxmoxStatus: 'running', state: 'ready',
    ipAddress: '10.1.1.2', snapshot: { exists: true, createdAt: 1793192400 },
    customization: { taskResults: { task: { name: 'Install', status: 'succeeded', output: `Output ${vmid}` } } }
  });
  const payload = { deployment: { id: 'lab', status: 'running', canManageSnapshots: true, canRedeployWorkstations: true },
    vms: [machine(1, 1, 'ubuntu'), machine(2, 1, 'windows11'), machine(3, 2, 'windows-server')] };
  api.renderDeploymentVmDetails(payload);
  const root = document.getElementById('deploymentVmDetailsList');
  assert.equal(root.querySelectorAll('.workstation-detail-card').length, 2);
  assert.equal(root.querySelector('[data-workstation-number="1"]').querySelectorAll('.deployment-vm-card').length, 2);
  assert.equal(root.querySelectorAll('table').length, 0);
  assert.equal(root.querySelectorAll('.workstation-redeploy-button').length, 2);
  const vm1 = root.querySelector('.deployment-vm-card[data-vmid="1"]');
  const vm2 = root.querySelector('.deployment-vm-card[data-vmid="2"]');
  assert.equal(vm1.querySelector('.pause-updates-button'), null);
  assert.equal(vm2.querySelector('.pause-updates-button').dataset.vmid, '2');
  assert.equal(vm2.querySelector('[data-snapshot-action="restore"]').dataset.vmid, '2');
  vm2.querySelector('.vm-select').click();
  vm2.querySelector('details').open = true;
  vm2.querySelector('[data-snapshot-action="delete"]').focus();
  api.preserveDetailView(() => api.renderDeploymentVmDetails(payload));
  assert.equal(root.querySelector('.deployment-vm-card[data-vmid="1"] details').open, false);
  assert.equal(root.querySelector('.deployment-vm-card[data-vmid="2"] details').open, true);
  assert.equal(document.activeElement.dataset.vmid, '2');
  assert.equal(document.activeElement.dataset.snapshotAction, 'delete');
  assert.equal(root.querySelector('.vm-selection-count').textContent, '1 / 3 selected');
  const all = root.querySelector('.vm-select-all'); all.checked = true;
  all.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(root.querySelectorAll('.vm-select:checked').length, 3);
});

test('VM credentials show usernames and reveal each password only on request', async t => {
  const { api, document } = setup(t);
  await api.bootstrap();
  const payload = { deployment: { id: 'lab', status: 'running' }, vms: [
    { vmid: 1, name: 'Ubuntu', osType: 'ubuntu', username: 'ubuntu', password: '<secret>&123' },
    { vmid: 2, name: 'Windows', osType: 'windows11', username: 'Administrator', password: 'second-secret' }
  ] };
  api.renderDeploymentVmDetails(payload);
  const root = document.getElementById('deploymentVmDetailsList');
  assert(root.textContent.includes('Administrator'));
  assert(!root.innerHTML.includes('secret'));
  const button = root.querySelector('.vm-password-toggle');
  button.click();
  assert.equal(root.querySelector('.vm-password-value').textContent, '<secret>&123');
  assert.equal(root.querySelector('secret'), null);
  assert(!root.textContent.includes('second-secret'));
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  button.click();
  assert(!root.innerHTML.includes('secret'));
  button.click();
  api.renderDeploymentVmDetails(payload);
  assert(!root.innerHTML.includes('secret'));
});

test('blueprint cards preview VM names and OS with overflow count and escaped content', t => {
  const { api, document } = setup(t);
  api.state.blueprints = [{ id: 'preview', name: 'Preview', vmCount: 6, updatedAt: new Date().toISOString(), previewVms: [
    { name: '<script>VM</script>', osType: 'ubuntu' },
    { name: 'DC', osType: 'windows-server' },
    { name: 'Client', osType: 'windows11' },
    { name: 'Other', osType: 'other' }
  ] }];
  api.renderBlueprintList();
  const preview = document.querySelector('.blueprint-preview');
  assert.equal(preview.querySelectorAll('.blueprint-preview-vm').length, 4);
  assert.equal(preview.querySelector('script'), null);
  assert(preview.textContent.includes('<script>VM</script>'));
  assert.equal(preview.querySelector('.blueprint-preview-more').textContent, '+2 VM');
  assert.equal(preview.querySelector('img').getAttribute('src'), '/assets/os-ubuntu.png');
});

test('delete blueprint does not also trigger opening that blueprint', async t => {
  const { api, document, requests } = setup(t); await api.bootstrap();
  document.querySelector('.delete-blueprint-button').click(); await tick();
  assert(!requests.some(request => request.url === '/api/blueprints/bp'));
  document.querySelector('.confirmation-dialog').close('cancel');
});

test('errors have an accessible, explicit dismiss action', t => {
  const { api, document } = setup(t);
  const target = document.getElementById('globalStatus');
  api.showMessage(target, '<script>example</script>', 'danger');
  assert.equal(target.getAttribute('role'), 'alert');
  assert.equal(target.querySelector('script'), null);
  target.querySelector('button').click(); assert(target.hidden);
});

test('deploy confirmation accepts corrected input after an invalid submission', async t => {
  const { api, document, w } = setup(t);
  const pending = api.promptDeploymentConflict({ deploymentNumber: 12, blueprint: { name: 'Lab' }, status: 'running' });
  const form = document.getElementById('deploymentConflictForm');
  const input = document.getElementById('deploymentConflictConfirmInput');
  input.value = 'wrong'; form.requestSubmit();
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(document.getElementById('deploymentConflictError').hidden, false);
  input.value = ' DEPLOY '; input.dispatchEvent(new w.Event('input'));
  assert.equal(input.validationMessage, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
  form.requestSubmit(); assert.equal(await pending, true);
  assert.equal(document.getElementById('deploymentConflictDialog').open, false);
});

test('deploy confirmation resolves false on Escape, close and Cancel, and can reopen', async t => {
  const { api, document, w } = setup(t);
  const dialog = document.getElementById('deploymentConflictDialog');
  for (const action of ['escape', 'close', 'cancel']) {
    const pending = api.promptDeploymentConflict({});
    if (action === 'escape') dialog.dispatchEvent(new w.Event('cancel', { cancelable: true }));
    if (action === 'close') dialog.close();
    if (action === 'cancel') document.getElementById('deploymentConflictCancelButton').click();
    assert.equal(await pending, false);
    assert.equal(dialog.open, false);
  }
});

test('saving clears the dirty state and a lab deep link opens a modal over the labs page', async t => {
  const { api, document, w } = setup(t); await api.bootstrap();
  await api.setActiveView('blueprint'); await api.loadBlueprint('bp');
  api.state.currentBlueprint.name = 'Edited';
  document.getElementById('blueprintName').value = 'Edited';
  assert(api.isBlueprintDirty());
  await api.saveBlueprint(); assert.equal(api.isBlueprintDirty(), false);
  assert.equal(document.getElementById('blueprintWorkspace').inert, false);
  await api.openDeploymentDetails('lab');
  assert.equal(w.location.hash, '#/lifecycle/lab');
  assert.equal(document.getElementById('deploymentDetailsDialog').tagName, 'DIALOG');
  assert.equal(document.getElementById('deploymentDetailsDialog').open, true);
  assert.equal(document.querySelector('.page[data-view="lifecycle"]').hidden, false);
  document.getElementById('closeDeploymentDetailsButton').click(); await tick();
  assert.equal(w.location.hash, '#/lifecycle');
  assert.equal(document.getElementById('deploymentDetailsDialog').open, false);
});

test('lab modal closes on Escape and navigation without overwriting the destination URL', async t => {
  const { api, document, w } = setup(t); await api.bootstrap();
  const dialog = document.getElementById('deploymentDetailsDialog');
  await api.openDeploymentDetails('lab');
  dialog.dispatchEvent(new w.Event('cancel', { cancelable: true }));
  assert.equal(dialog.open, false);
  assert.equal(api.state.activeDeploymentDetailsId, null);
  assert.equal(w.location.hash, '#/lifecycle');
  await api.openDeploymentDetails('lab');
  await api.setActiveView('dashboard');
  assert.equal(dialog.open, false);
  assert.equal(w.location.hash, '#/dashboard');
  // Native browsers deliver the close event asynchronously.
  dialog.dispatchEvent(new w.Event('close'));
  assert.equal(w.location.hash, '#/dashboard');
  await api.openDeploymentDetails('other');
  dialog.dispatchEvent(new w.Event('close'));
  assert.equal(api.state.activeDeploymentDetailsId, 'other');
  assert.equal(dialog.open, true);
});


test('classroom deploy shortcut selects the room without creating a deployment', async t => {
  const { api, document, w, requests } = setup(t);
  await api.bootstrap();
  api.state.classrooms = [{ id: 'room', name: 'A39', workstationCount: 22, vlans: [200], subnetOctets: [200] }];
  document.getElementById('deploymentClassroomSelect').add(new w.Option('A39', 'room'));
  api.renderDashboard();
  document.querySelector('.dash-classroom-deploy').click();
  await tick();
  assert.equal(document.getElementById('deploymentClassroomSelect').value, 'room');
  assert.equal(document.activeElement.id, 'deploymentBlueprintSelect');
  assert.equal(document.getElementById('deployLabDialog').open, true);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
});

test('blueprint deployment dialog retries failed launch without creating a second record', async t => {
  const { api, document, w } = setup(t);
  await api.bootstrap();
  api.state.classrooms = [{ id: 'room', name: 'A39', workstationCount: 22, vlans: [200], subnetOctets: [200] }];
  api.renderBlueprintList();
  document.querySelector('.blueprint-deploy-button').click();
  const dialog = document.getElementById('deployLabDialog');
  assert.equal(dialog.open, true);
  assert.equal(document.getElementById('deploymentBlueprintSelect').value, 'bp');
  assert.equal(document.activeElement.id, 'deploymentClassroomSelect');
  assert.equal(api.state.currentBlueprint.id, null);
  document.getElementById('deploymentClassroomSelect').value = 'room';
  const originalFetch = w.fetch;
  let creates = 0, launches = 0;
  w.fetch = async (url, options = {}) => {
    if (url === '/api/lifecycle/deployments' && options.method === 'POST') {
      creates++;
      assert.deepEqual(JSON.parse(options.body), { blueprintId: 'bp', classroomId: 'room' });
      return { ok: true, json: async () => ({ deployment: { id: 'new-lab' } }) };
    }
    if (url === '/api/lifecycle/deployments/new-lab/deploy') {
      launches++;
      return { ok: launches > 1, json: async () => launches === 1 ? { error: 'Queue unavailable' } : { jobId: 'job' } };
    }
    return originalFetch(url, options);
  };
  const form = document.getElementById('deploymentForm');
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(dialog.open, true);
  assert.equal(document.getElementById('deploymentDialogError').textContent, 'Queue unavailable');
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(creates, 1);
  assert.equal(launches, 2);
  assert.equal(dialog.open, false);
  assert.equal(w.location.hash, '#/lifecycle');
});

test('modules search and edit dialog preserve data when cancelled and reset for creation', async t => {
  const { api, document, w, requests } = setup(t);
  await api.bootstrap();
  api.state.courses = [{ id: 'module-a', courseNumber: 101, description: 'Networks', updatedAt: '2026-10-10' }, { id: 'module-b', courseNumber: 202, description: 'Linux', updatedAt: '2026-10-10' }];
  const search = document.getElementById('moduleSearch');
  search.value = 'Linux';
  search.dispatchEvent(new w.Event('input'));
  assert.equal(document.querySelectorAll('.module-card').length, 1);
  document.querySelector('.edit-course-button').click();
  const dialog = document.getElementById('moduleDialog');
  const number = document.getElementById('courseForm').elements.courseNumber;
  assert.equal(dialog.open, true);
  assert.equal(number.value, '202');
  number.value = '303';
  document.getElementById('cancelCourseEdit').click();
  assert.equal(dialog.open, false);
  assert.equal(api.state.courses[1].courseNumber, 202);
  document.getElementById('newModuleButton').click();
  assert.equal(dialog.open, true);
  assert.equal(number.value, '');
  assert.equal(document.getElementById('moduleDialogTitle').textContent, 'Add module');
  assert.equal(requests.filter(request => request.method === 'POST' || request.method === 'PUT').length, 0);
});

test('dashboard shows other teachers labs and attention items even when only my labs is selected', t => {
  const { api, document } = setup(t);
  api.state.isAdmin = false;
  api.state.auth = { enabled: true };
  api.state.currentUser = { email: 'me@example.org', roles: ['teacher'] };
  api.state.showOnlyMyLabs = true;
  api.state.classrooms = [{ id: 'room', name: 'Room', workstationCount: 1 }];
  api.state.deployments = ['running', 'failed'].map(status => ({
    id: status, status, teacherEmail: 'other@example.org', deploymentNumber: 1,
    blueprint: { name: `Other ${status}` }, classroom: api.state.classrooms[0], totalVmCount: 1
  }));
  api.renderDashboard();
  assert.equal(document.querySelectorAll('#dashClassroomsGrid .dash-classroom-lab').length, 2);
  assert.match(document.getElementById('attentionLabs').textContent, /Other failed/);
  assert(document.querySelector('#dashClassroomsGrid [data-action="stop"]'));
  assert.equal(document.querySelector('#dashClassroomsGrid [data-action="destroy"]'), null);
});

test('dashboard tiles expose power actions according to lab status', t => {
  const { api, document } = setup(t);
  api.state.isAdmin = true;
  api.state.classrooms = [{ id: 'room', name: 'Room', workstationCount: 1 }];
  api.state.deployments = ['running', 'stopped', 'mixed', 'starting', 'failed'].map((status, i) => ({
    id: status, status, deploymentNumber: i + 1, blueprint: { name: 'Lab' },
    classroom: api.state.classrooms[0], totalVmCount: 1
  }));
  api.renderDashboard();
  assert.equal(document.getElementById('dashRecentLabsList'), null);
  for (const container of ['dashClassroomsGrid']) {
    const root = document.getElementById(container);
    const actions = id => [...root.querySelectorAll('[data-deployment-id="' + id + '"]')].map(b => b.dataset.action);
    assert.deepEqual(actions('running'), ['stop']);
    assert.deepEqual(actions('stopped'), ['start']);
    assert.deepEqual(actions('mixed'), ['start', 'stop']);
    assert.deepEqual(actions('starting'), []);
    assert.deepEqual(actions('failed'), []);
    assert(root.querySelector('[role="status"]'));
  }
});
