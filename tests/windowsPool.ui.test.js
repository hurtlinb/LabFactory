// "Windows pool" page of the dashboard (lot P6): rendering and API calls, with jsdom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('dashboard/public/index.html', 'utf8');
const tWin = '11111111-1111-1111-1111-111111111111';
const tW11 = '22222222-2222-2222-2222-222222222222';
const overview = {
  settings: { cluster: 'default', paused: false, proxmoxPool: 'labs-dev', dnsServers: ['195.186.4.162', '195.186.4.163'], vmidMin: 70000, vmidMax: 79999, maxCapacity: 40 },
  templates: [
    { templateId: tWin, name: 'Windows 2022 v2', osType: 'windows-server', proxmoxTemplateVmid: 147, configured: true,
      config: { enabled: true, readyTarget: 2, maxParallelPreparations: 2, node: 'peda-pve2', storage: 'ceph-pool', revision: 1, sourceTemplateVmid: 147 },
      counts: { ready: 1, preparing: 1, reserved: 0, assigned: 3, quarantined: 1, deleting: 0 } },
    { templateId: tW11, name: 'Windows 11 26H2', osType: 'windows11', proxmoxTemplateVmid: 148, configured: true,
      config: { enabled: false, readyTarget: 0, maxParallelPreparations: 1, node: 'peda-pve2', storage: 'ceph-pool', revision: 2, sourceTemplateVmid: 149 },
      counts: { ready: 0, preparing: 0, reserved: 0, assigned: 0, quarantined: 0, deleting: 0 } }
  ],
  requests: [{ id: 'r1', deploymentId: 'lab-1', deploymentNumber: 42, blueprintName: 'Win domain', classroomName: 'A43', deploymentStatus: 'waiting_for_pool',
    kind: 'deploy', status: 'waiting_for_pool', blockedReason: 'INSUFFICIENT_STOCK', createdAt: new Date(Date.now() - 125_000).toISOString(),
    demand: [{ templateId: tWin, count: 3, readyNow: 1, missing: 2 }] }],
  limits: [{ category: 'clone', scope: 'cluster', maxActive: 2, active: 1, withProxmoxTask: 1 }],
  quarantined: [{ id: 'q1', vmid: 70007, templateId: tWin, revision: 1, errorCode: 'BOOTSTRAP_ERRORS', lastError: 'errorCount=2', since: new Date().toISOString() }],
  metrics: { days: 7, preparation: { count: 4, p50Seconds: 402, p90Seconds: 410, maxSeconds: 412 }, poolWait: { count: 3, p50Seconds: 0, p90Seconds: 5, maxSeconds: 403 },
    poolWaitWhenStockEmpty: { count: 1, p50Seconds: 403, p90Seconds: 403, maxSeconds: 403 }, assignment: { count: 3, p50Seconds: 49, p90Seconds: 52, maxSeconds: 52 } }
};

async function setup(t) {
  const dom = new JSDOM(html, { url: 'https://labfactory.test/#/dashboard' });
  // Leaving the page stops its periodic refresh (as in real use), then the window is closed.
  t.after(() => {
    dom.window.dispatchEvent(new dom.window.CustomEvent('labfactory:view', { detail: { view: 'dashboard' } }));
    dom.window.close();
  });
  const calls = [];
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, location: window.location, CustomEvent: window.CustomEvent, HTMLElement: window.HTMLElement });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => (url.includes('cancel-pool-wait') ? { ok: true } : overview) };
  };
  window.confirm = () => true;
  window.prompt = (_message, value) => (calls.promptAnswer ?? value);
  await import(`../dashboard/public/windowsPool.js?${Math.random()}`);
  window.dispatchEvent(new window.CustomEvent('labfactory:view', { detail: { view: 'admin-windows-pool' } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  return { window, document: window.document, calls, page: window.document.querySelector('.page[data-view="admin-windows-pool"]') };
}
const click = async (window, element) => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 20)); };

test('pool page: admin navigation, counters, state and missing needs', async t => {
  const { document, calls, page } = await setup(t);
  assert.ok(document.querySelector('nav [data-view="admin-windows-pool"][data-role-group="admin"], [data-view="admin-windows-pool"][data-role-group="admin"]'), 'admin-only entry');
  assert.equal(calls[0].url, '/api/windows-pool');
  const rows = [...page.querySelectorAll('#poolTemplatesBody tr')].map(tr => tr.textContent.replace(/\s+/g, ' '));
  assert.match(rows[0], /Windows 2022 v2.*Enabled.*rev\. 1.*1.*1.*0.*3.*1.*2/);
  assert.match(rows[1], /Disabled.*rev\. 2/);
  // Activation on the VM Models page (2026-11-21): neither qualification nor Enable/Disable here.
  assert.ok(!page.querySelector('[data-pool-action="qualify"], [data-pool-action="enable"], [data-pool-action="disable"]'));
  assert.match(page.textContent, /VM Templates/);
  assert.equal(document.getElementById('poolMaxCapacity').value, '40', 'global ceiling in the settings');
  const request = page.querySelector('#poolRequestsBody tr').textContent;
  assert.match(request, /Win domain — A43 #42/);
  assert.match(request, /Waiting for VMs to be prepared/);
  assert.match(request, /2 × Windows 2022 v2/);
  const text = selector => page.querySelector(selector).textContent.replace(/\s+/g, ' ');
  assert.match(text('#poolMetricsBody'), /Lab wait when the stock was empty ?1 ?6 min 43 s/);
  assert.match(text('#poolMetricsBody'), /Network assignment of a VM ?3 ?49 s/);
  assert.match(text('#poolLimitsBody'), /Linked clones cluster 1 \(1 Proxmox task\) 2 Change/);
  assert.match(page.querySelector('#poolQuarantineBody').textContent, /70007.*BOOTSTRAP_ERRORS/s);
  assert.equal(document.getElementById('poolProxmoxPool').value, 'labs-dev');
  assert.equal(document.getElementById('poolDnsServers').value, '195.186.4.162, 195.186.4.163');
});

test('pool page: actions call the right API', async t => {
  const { window, document, calls, page } = await setup(t);
  await click(window, page.querySelector('[data-pool-action="cancel-lab"]'));
  assert.deepEqual(calls.find(c => c.url.includes('cancel-pool-wait')), { url: '/api/lifecycle/deployments/lab-1/cancel-pool-wait', method: 'POST', body: null });
  calls.promptAnswer = '3';
  await click(window, page.querySelector('[data-pool-action="limit"]'));
  assert.deepEqual(calls.find(c => c.url === '/api/windows-pool/limits').body, { category: 'clone', scope: 'cluster', maxActive: 3 });
  await click(window, page.querySelector('[data-pool-action="destroy-vm"]'));
  assert.equal(calls.find(c => c.url.endsWith('/destroy')).url, '/api/windows-pool/vms/q1/destroy');
  // Template configuration form.
  await click(window, page.querySelector(`[data-pool-action="configure"][data-template="${tWin}"]`));
  assert.equal(document.getElementById('poolTemplateForm').hidden, false);
  document.getElementById('poolMaxParallel').value = '3';
  document.getElementById('poolTemplateForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(calls.find(c => c.url === `/api/windows-pool/templates/${tWin}` && c.method === 'PUT').body,
    { node: 'peda-pve2', storage: 'ceph-pool', maxParallelPreparations: 3 });
  // Global settings.
  document.getElementById('poolPaused').checked = true;
  document.getElementById('poolDnsServers').value = '10.0.0.1; 10.0.0.2';
  document.getElementById('poolSettingsForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(calls.find(c => c.url === '/api/windows-pool/settings').body, { paused: true, proxmoxPool: 'labs-dev', dnsServers: ['10.0.0.1', '10.0.0.2'], vmidMin: 70000, vmidMax: 79999, maxCapacity: 40 });
});

test('pool page: visible errors next to the form, warnings, unconfigured template configurable', async t => {
  const { window, document, calls, page } = await setup(t);
  // Warnings: suspended pool / enabled template with reserve 0.
  overview.settings.paused = true;
  overview.templates[0].config.readyTarget = 0;
  await click(window, document.getElementById('poolRefreshButton'));
  const warnings = document.getElementById('poolWarnings');
  assert.equal(warnings.hidden, false);
  assert.match(warnings.textContent, /suspended/);
  assert.match(warnings.textContent, /Windows 2022 v2 is enabled with a ready reserve of 0/);
  overview.settings.paused = false;
  overview.templates[0].config.readyTarget = 2;
  // Inconsistent configuration: refused BEFORE sending, message next to the form.
  await click(window, page.querySelector(`[data-pool-action="configure"][data-template="${tW11}"]`));
  document.getElementById('poolStorage').value = '';
  const before = calls.length;
  document.getElementById('poolTemplateForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, before, 'no request sent');
  const templateStatus = document.getElementById('poolTemplateStatus');
  assert.equal(templateStatus.hidden, false);
  assert.match(templateStatus.textContent, /Not saved: storage is required/);
  // Server error: displayed next to the form (no longer only at the top of the page).
  const failingFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => (options.method === 'PUT'
    ? { ok: false, json: async () => ({ error: 'node: Invalid' }) } : failingFetch(url, options));
  document.getElementById('poolStorage').value = 'ceph-pool';
  document.getElementById('poolTemplateForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.match(templateStatus.textContent, /Not saved: node: Invalid/);
  assert.equal(document.getElementById('poolTemplateForm').hidden, false, 'form kept for correction');
  globalThis.fetch = failingFetch;
  // "Suspended" toggle visible: same structure as the other dashboard switches (the .switch CSS hides the native input).
  const toggle = document.getElementById('poolPaused').closest('.switch');
  assert.ok(toggle.querySelector('.switch-track .switch-thumb') && toggle.querySelector('.switch-label'));
  // Pattern valid in the browsers' regular-expression mode (v flag).
  assert.doesNotThrow(() => new RegExp(`^(?:${document.getElementById('poolNode').getAttribute('pattern')})$`, 'v'));
});

test('lab waiting for the pool: "Cancel" action offered in the lab list', () => {
  const source = readFileSync('dashboard/public/app.js', 'utf8');
  assert.match(source, /status === 'waiting_for_pool'\) \{\s*return \{ busy: false, items: \[\{ action: 'cancel-pool-wait'/);
  assert.match(source, /'cancel-pool-wait'\]\.includes\(action\) && !await confirmLabAction/);
});
