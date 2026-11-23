import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as helpers from '../dashboard/public/ux.js';

const html = readFileSync('dashboard/public/index.html', 'utf8');
const source = readFileSync('dashboard/public/app.js', 'utf8')
  .replace(/^import .*from '.\/ux.js';\s*/, '')
  .replace(/bootstrap\(\)\.catch\(error => \{[\s\S]*?\n\}\);/, '');

const templates = [
  { id: 'win', name: 'Windows 2022 v3', osType: 'windows-server', proxmoxTemplateVmid: 9100, windowsPool: { enabled: true, readyTarget: 12, ready: 10 } },
  { id: 'win-off', name: 'Windows 11', osType: 'windows11', proxmoxTemplateVmid: 9200, windowsPool: { enabled: false, readyTarget: 0, ready: 0 } },
  { id: 'ubuntu', name: 'Ubuntu', osType: 'ubuntu', proxmoxTemplateVmid: 9000, windowsPool: null }
];
const blueprint = { id: 'bp', name: 'Lab', description: '', course: { id: 'course', courseNumber: 101 }, vms: [{ id: 'vm', name: 'DC', templateId: 'win', template: { id: 'win' }, config: {} }], updatedAt: new Date().toISOString() };

function setup(t) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, helpers);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.fetch = async url => {
    const data = url === '/api/app-info' ? { auth: { enabled: false } } :
      url === '/api/templates' ? templates :
      url === '/api/blueprints/bp' ? blueprint :
      url === '/api/blueprints' ? [{ ...blueprint, vmCount: 1 }] :
      url === '/api/courses' ? [{ id: 'course', courseNumber: 101 }] :
      ['/api/health', '/api/timezones', '/api/announcement'].includes(url) ? {} : [];
    return { ok: true, json: async () => data };
  };
  w.setInterval = () => 1;
  w.eval(source + '\nwindow.uxTest = { bootstrap, setActiveView, loadBlueprint };');
  return { w, api: w.uxTest, document: w.document };
}

test('blueprint palette marks templates with the Windows pool enabled, with an explanatory tooltip', async t => {
  const { api, document, w } = setup(t);
  await api.bootstrap();
  await api.setActiveView('blueprint');
  const badgeOf = id => document.querySelector(`#templatePalette .vm-lib-item[data-template-id="${id}"] .pool-badge`);
  const badge = badgeOf('win');
  assert(badge, 'pool badge on the enabled template');
  assert.equal(badgeOf('win-off'), null);
  assert.equal(badgeOf('ubuntu'), null);
  assert.match(badge.dataset.tooltip, /Windows pool enabled: 12 VMs are kept ready/);
  assert.equal(badge.getAttribute('aria-label'), badge.dataset.tooltip);

  badge.dispatchEvent(new w.Event('pointerover', { bubbles: true }));
  const tip = document.getElementById('uiTooltip');
  assert.equal(tip.hidden, false);
  assert.equal(tip.textContent, badge.dataset.tooltip);
  assert.equal(badge.getAttribute('aria-describedby'), 'uiTooltip');
  badge.dispatchEvent(new w.Event('pointerout', { bubbles: true }));
  assert.equal(tip.hidden, true);

  await api.loadBlueprint('bp');
  const cardBadge = document.querySelector('.vm-card[data-vm-id="vm"] .pool-badge');
  assert(cardBadge, 'pool badge on the VM card of the blueprint');
  assert.equal(cardBadge.textContent.trim(), 'Pool');
});
