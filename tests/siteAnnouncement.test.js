import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as helpers from '../dashboard/public/ux.js';
import { activeAnnouncement, readAnnouncement, validateAnnouncement, writeAnnouncement } from '../lib/siteAnnouncement.js';

test('announcement validation requires a message to show the banner', () => {
  assert.deepEqual(validateAnnouncement({ enabled: true, level: 'warning', message: '  Maintenance  ' }).value,
    { enabled: true, level: 'warning', message: 'Maintenance', endsAt: null });
  assert(validateAnnouncement({ enabled: true, message: '   ' }).errors.message);
  assert.equal(validateAnnouncement({ enabled: false, message: '' }).value.enabled, false);
  assert(validateAnnouncement({ enabled: true, level: 'fatal', message: 'x' }).errors.level);
  assert(validateAnnouncement({ enabled: true, message: 'x'.repeat(501) }).errors.message);
  assert(validateAnnouncement({ enabled: true, message: 'x', endsAt: 'tomorrow' }).errors.endsAt);
  assert.equal(validateAnnouncement({ enabled: true, message: 'x', endsAt: '2026-11-24T10:15:00Z' }).value.endsAt, '2026-11-24T10:15:00.000Z');
});

test('active announcement hides disabled, empty and expired banners', () => {
  const now = new Date('2026-11-24T09:00:00Z');
  const base = { enabled: true, level: 'danger', message: 'Proxmox outage', endsAt: null, updatedAt: null };
  assert.equal(activeAnnouncement(base, now).message, 'Proxmox outage');
  assert.equal(activeAnnouncement({ ...base, enabled: false }, now), null);
  assert.equal(activeAnnouncement({ ...base, message: ' ' }, now), null);
  assert.equal(activeAnnouncement({ ...base, endsAt: '2026-11-24T08:59:00Z' }, now), null);
  assert(activeAnnouncement({ ...base, endsAt: '2026-11-24T10:15:00Z' }, now));
});

test('announcement storage reads defaults before the migration and maps rows', async () => {
  const missing = { query: async () => { const error = new Error('missing'); error.code = '42P01'; throw error; } };
  assert.equal((await readAnnouncement(missing)).enabled, false);
  let params;
  const db = { query: async (_sql, values) => { params = values; return { rows: [{ enabled: true, level: 'info', message: 'Hello', ends_at: null, updated_at: new Date('2026-11-23T10:00:00Z'), updated_by: 'admin@example.org' }] }; } };
  const saved = await writeAnnouncement(db, { enabled: true, level: 'info', message: 'Hello', endsAt: null }, 'admin@example.org');
  assert.deepEqual(params, [true, 'info', 'Hello', null, 'admin@example.org']);
  assert.equal(saved.updatedBy, 'admin@example.org');
  assert.equal(saved.updatedAt, '2026-11-23T10:00:00.000Z');
});

const html = readFileSync('dashboard/public/index.html', 'utf8');
const source = readFileSync('dashboard/public/app.js', 'utf8')
  .replace(/^import .*from '.\/ux.js';\s*/, '')
  .replace(/bootstrap\(\)\.catch\(error => \{[\s\S]*?\n\}\);/, '');

function setup(t, { announcement = null, admin = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.assign(w, helpers);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const requests = [];
  let settings = { enabled: false, level: 'info', message: '', endsAt: null, updatedAt: null, updatedBy: null };
  const live = { current: announcement };
  w.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    let data;
    if (url === '/api/app-info') data = { auth: admin ? { enabled: true, user: { email: 'admin@example.org', roles: ['admin'] } } : { enabled: false } };
    else if (url === '/api/announcement') data = { announcement: live.current };
    else if (url === '/api/settings/announcement' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      settings = { ...body, updatedAt: '2026-11-23T10:00:00.000Z', updatedBy: 'admin@example.org' };
      live.current = body.enabled ? { level: body.level, message: body.message, endsAt: body.endsAt } : null;
      data = settings;
    } else if (url === '/api/settings/announcement') data = settings;
    else if (['/api/health', '/api/timezones', '/api/maintenance/files'].includes(url)) data = url === '/api/maintenance/files' ? { storedFileCount: 0, totalBytes: 0, availableBytes: 0, capacityBytes: 0, files: [] } : {};
    else data = [];
    return { ok: true, json: async () => data };
  };
  w.setInterval = () => 1;
  w.eval(source + '\nwindow.uxTest = { state, bootstrap, setActiveView, loadSiteAnnouncement };');
  return { w, api: w.uxTest, requests, document: w.document };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('the banner is shown on every page with its level, and hidden without announcement', async t => {
  const { api, document } = setup(t, { announcement: { level: 'danger', message: 'Proxmox outage\nDeployments are paused.' } });
  await api.bootstrap();
  const banner = document.getElementById('siteAnnouncement');
  assert.equal(banner.hidden, false);
  assert.equal(banner.dataset.level, 'danger');
  assert.equal(banner.getAttribute('role'), 'alert');
  assert.equal(document.getElementById('siteAnnouncementText').textContent, 'Proxmox outage\nDeployments are paused.');
  // Outside the pages: visible whatever the active view.
  assert.equal(banner.closest('.page'), null);

  const empty = setup(t);
  await empty.api.bootstrap();
  assert.equal(empty.document.getElementById('siteAnnouncement').hidden, true);
});

test('admins configure the banner from the Maintenance page', async t => {
  const { api, document, requests, w } = setup(t, { admin: true });
  await api.bootstrap();
  api.state.isAdmin = true;
  await api.setActiveView('admin-settings');
  await tick();
  assert(requests.some(request => request.url === '/api/settings/announcement' && !request.method));
  document.getElementById('announcementEnabled').checked = true;
  document.getElementById('announcementLevel').value = 'warning';
  document.getElementById('announcementMessage').value = 'Maintenance on Tuesday 8:15-10:15';
  document.getElementById('announcementForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick(); await tick(); await tick();
  const put = requests.find(request => request.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { enabled: true, level: 'warning', message: 'Maintenance on Tuesday 8:15-10:15', endsAt: null });
  const banner = document.getElementById('siteAnnouncement');
  assert.equal(banner.hidden, false);
  assert.equal(banner.dataset.level, 'warning');
  assert.match(document.getElementById('announcementMeta').textContent, /admin@example\.org/);
});
