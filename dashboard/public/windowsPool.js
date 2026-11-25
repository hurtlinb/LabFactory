// "Windows pool" administration page (lot P6). Independent module: it listens to the
// 'labfactory:view' event emitted by app.js and only uses the /api/windows-pool API.

const VIEW = 'admin-windows-pool';
const REFRESH_MS = 10_000;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const REASONS = {
  INSUFFICIENT_STOCK: 'Waiting for VMs to be prepared',
  QUEUED_BEHIND_OLDER_REQUEST: 'Queued behind an older lab',
  POOL_PAUSED: 'Pool suspended',
  TEMPLATE_DISABLED: 'Template disabled',
  DEMAND_EXCEEDS_CAPACITY: 'Demand exceeds the template capacity'
};
const CATEGORIES = {
  clone: 'Linked clones', prepare: 'Preparations (boot to ready)', guest_probe: 'Guest agent probes',
  assign: 'Lab assignments (network)', customize: 'Customization commands (Ansible)', lifecycle: 'Life cycle', destroy: 'Destructions'
};

let overview = null;
let timer = null;
let active = false;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

// Message displayed NEXT TO the form or the action that triggered it (target), and brought
// into view: an error far from the clicked button went unnoticed ("nothing happens").
function status(message, kind = 'success', target = 'poolStatus') {
  const element = $(target) ?? $('poolStatus');
  if (!element) return;
  element.textContent = message;
  element.className = `status-message ${kind}`;
  element.hidden = !message;
  if (message) element.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  if (message && kind === 'success') setTimeout(() => { if (element.textContent === message) element.hidden = true; }, 5000);
}

// Confirmation in the app style (same markup and classes as chooseAction() in app.js; this
// module is independent of app.js). Resolves to null when cancelled, otherwise to the value of
// the optional number field ('' without field).
function askDialog({ title, message, confirmLabel, danger = false, field = null }) {
  if (document.querySelector('.confirmation-dialog')) return Promise.resolve(null);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal-dialog confirmation-dialog';
    dialog.setAttribute('aria-labelledby', 'confirmationTitle');
    dialog.setAttribute('aria-describedby', 'confirmationMessage');
    dialog.innerHTML = '<form method="dialog" class="modal-card"><h2 id="confirmationTitle"></h2><p id="confirmationMessage"></p><div class="inline-actions"></div></form>';
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('p').textContent = message;
    let input = null;
    if (field) {
      const label = document.createElement('label');
      label.className = 'field';
      const caption = document.createElement('span');
      caption.textContent = field.label;
      input = document.createElement('input');
      Object.assign(input, { type: 'number', min: '0', step: '1', required: true, value: field.value ?? '' });
      label.append(caption, input);
      dialog.querySelector('p').after(label);
    }
    for (const [value, text, style] of [['cancel', 'Cancel', 'btn-secondary'], ['confirm', confirmLabel, danger ? 'btn-danger' : 'btn-primary']]) {
      const button = document.createElement('button');
      button.type = 'submit'; button.value = value; button.textContent = text;
      button.className = `btn ${style}`;
      if (value === 'cancel') button.formNoValidate = true;
      dialog.querySelector('.inline-actions').append(button);
    }
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'confirm';
      const value = input ? input.value : '';
      dialog.remove();
      resolve(confirmed ? value : null);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    input?.focus();
  });
}

// Explicit warnings: suspended pool, or enabled template that prepares nothing in advance.
function renderWarnings() {
  const element = $('poolWarnings');
  if (!element) return;
  const warnings = [];
  if (overview.settings?.paused) {
    warnings.push('The pool is suspended: no VM is prepared or assigned. Uncheck "Suspended" and save the settings to start it.');
  }
  for (const t of overview.templates.filter(item => item.config?.enabled && item.config.readyTarget === 0)) {
    warnings.push(`${t.name} is enabled with a ready reserve of 0: no VM is prepared in advance, labs will wait for a full preparation (about 7 minutes).`);
  }
  if (overview.busyLabs > 0 && !overview.settings?.paused) {
    warnings.push(`Reserve refill on hold: ${overview.busyLabs} lab(s) being deployed, customized, started, stopped or destroyed. Missing VMs are recreated once they are done (labs waiting for the pool are still served).`);
  }
  element.innerHTML = warnings.map(text => `<p>${escapeHtml(text)}</p>`).join('');
  element.hidden = !warnings.length;
}

const formatSeconds = seconds => {
  if (seconds == null) return '—';
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
};
const formatSince = value => {
  if (!value) return '—';
  return formatSeconds(Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)));
};
const templateName = templateId => overview?.templates.find(t => t.templateId === templateId)?.name ?? templateId;

function renderSettings() {
  const s = overview.settings;
  if (!s) return;
  if (document.activeElement?.closest?.('#poolSettingsForm')) return; // do not overwrite an edit in progress
  $('poolPaused').checked = s.paused;
  $('poolProxmoxPool').value = s.proxmoxPool ?? '';
  $('poolDnsServers').value = (s.dnsServers ?? []).join(', ');
  $('poolMaxCapacity').value = s.maxCapacity ?? '';
  $('poolNode').value = s.node ?? '';
  $('poolStorage').value = s.storage ?? '';
  $('poolMaxParallel').value = s.maxParallelPreparations ?? '';
  $('poolVmidMin').value = s.vmidMin ?? '';
  $('poolVmidMax').value = s.vmidMax ?? '';
}

// Activation: VM Templates page (user decision 2026-11-21).
function templateState(t) {
  if (!t.configured) return '<span class="muted">Not used</span>';
  return `${t.config.enabled ? '<strong>Enabled</strong>' : 'Disabled'} <span class="muted">· rev. ${t.config.revision}</span>`;
}

function renderTemplates() {
  const rows = overview.templates.map(t => {
    const c = t.config;
    const counts = t.counts;
    return `<tr>
      <th scope="row">${escapeHtml(t.name)}<br><span class="muted">Proxmox ${escapeHtml(c?.sourceTemplateVmid ?? t.proxmoxTemplateVmid)}</span></th>
      <td>${templateState(t)}</td>
      <td>${counts.ready}</td><td>${counts.preparing}</td><td>${counts.reserved}</td><td>${counts.assigned}</td>
      <td>${counts.quarantined ? `<strong>${counts.quarantined}</strong>` : 0}</td>
      <td>${c ? c.readyTarget : '—'}</td>
    </tr>`;
  });
  $('poolTemplatesBody').innerHTML = rows.join('') || '<tr><td colspan="8" class="muted">No Windows template.</td></tr>';
}

function renderRequests() {
  const rows = overview.requests.map(r => {
    const missing = r.demand.filter(d => d.missing > 0).map(d => `${d.missing} × ${escapeHtml(templateName(d.templateId))}`).join(', ');
    const label = `${escapeHtml(r.blueprintName ?? 'Lab')} — ${escapeHtml(r.classroomName ?? '')}${r.deploymentNumber != null ? ` #${r.deploymentNumber}` : ''}`;
    return `<tr>
      <th scope="row">${label}<br><span class="muted">${r.kind === 'redeploy-workstation' ? 'Workplace redeploy' : 'Deployment'}</span></th>
      <td>${r.status === 'reserved' ? 'VMs reserved, being configured' : 'Waiting'}</td>
      <td>${escapeHtml(REASONS[r.blockedReason] ?? r.blockedReason ?? '—')}</td>
      <td>${missing || '—'}</td>
      <td>${formatSince(r.createdAt)}</td>
      <td>${r.status === 'waiting_for_pool' && r.deploymentStatus === 'waiting_for_pool'
        ? `<button type="button" class="btn btn-ghost" data-pool-action="cancel-lab" data-deployment="${escapeHtml(r.deploymentId)}">Cancel deployment</button>` : ''}</td>
    </tr>`;
  });
  $('poolRequestsBody').innerHTML = rows.join('') || '<tr><td colspan="6" class="muted">No lab waiting for the pool.</td></tr>';
}

function renderMetrics() {
  const m = overview.metrics;
  const row = (label, s) => `<tr><th scope="row">${label}</th><td>${s.count}</td><td>${formatSeconds(s.p50Seconds)}</td><td>${formatSeconds(s.p90Seconds)}</td><td>${formatSeconds(s.maxSeconds)}</td></tr>`;
  $('poolMetricsBody').innerHTML = [
    row('VM preparation (boot to ready)', m.preparation),
    row('Lab wait for the pool (all)', m.poolWait),
    row('Lab wait when the stock was empty', m.poolWaitWhenStockEmpty),
    row('Network assignment of a VM', m.assignment)
  ].join('');
}

function renderLimits() {
  $('poolLimitsBody').innerHTML = overview.limits.map(l => `<tr>
      <th scope="row">${escapeHtml(CATEGORIES[l.category] ?? l.category)}</th>
      <td>${escapeHtml(l.scope)}</td>
      <td>${l.active}${l.withProxmoxTask ? ` <span class="muted">(${l.withProxmoxTask} Proxmox task)</span>` : ''}</td>
      <td>${l.maxActive}</td>
      <td><button type="button" class="btn btn-ghost" data-pool-action="limit" data-category="${escapeHtml(l.category)}" data-scope="${escapeHtml(l.scope)}" data-max="${l.maxActive}">Change</button></td>
    </tr>`).join('');
}

function renderQuarantine() {
  $('poolQuarantineBody').innerHTML = overview.quarantined.map(q => `<tr>
      <th scope="row">${q.vmid}<br><span class="muted">${escapeHtml(templateName(q.templateId))} rev. ${q.revision}</span></th>
      <td>${escapeHtml(q.errorCode ?? '—')}</td>
      <td class="muted">${escapeHtml(String(q.lastError ?? '').slice(0, 300))}</td>
      <td>${formatSince(q.since)}</td>
      <td class="inline-actions">
        <button type="button" class="btn btn-ghost" data-pool-action="timeline" data-vm="${escapeHtml(q.id)}">Timeline</button>
        <button type="button" class="btn btn-danger" data-pool-action="destroy-vm" data-vm="${escapeHtml(q.id)}" data-vmid="${q.vmid}">Destroy</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No quarantined VM.</td></tr>';
}

function render() {
  if (!overview) return;
  renderWarnings();
  renderSettings();
  renderTemplates();
  renderRequests();
  renderMetrics();
  renderLimits();
  renderQuarantine();
}

async function load({ quiet = false } = {}) {
  try {
    overview = await api('/api/windows-pool');
    render();
  } catch (error) {
    if (!quiet) status(error.message, 'danger');
  }
}

async function act(fn, success, target = 'poolStatus') {
  try {
    const result = await fn();
    overview = result?.overview ?? (result?.templates ? result : overview);
    render();
    if (success) status(typeof success === 'function' ? success(result) : success, 'success', target);
    await load({ quiet: true });
    return true;
  } catch (error) {
    status(`Not saved: ${error.message}`, 'danger', target);
    return false;
  }
}

function bind() {
  $('poolRefreshButton')?.addEventListener('click', () => load());
  $('poolSettingsForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const dnsServers = $('poolDnsServers').value.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
    const proxmoxPool = $('poolProxmoxPool').value.trim();
    if (!dnsServers.length) return status('Not saved: at least one DNS server is required.', 'danger', 'poolSettingsStatus');
    const vmidMin = Number($('poolVmidMin').value);
    const vmidMax = Number($('poolVmidMax').value);
    if (!Number.isInteger(vmidMin) || !Number.isInteger(vmidMax) || vmidMin > vmidMax) {
      return status('Not saved: the VMID range is invalid (first ≤ last).', 'danger', 'poolSettingsStatus');
    }
    const maxCapacity = Number($('poolMaxCapacity').value);
    if (!Number.isInteger(maxCapacity) || maxCapacity < 1) return status('Not saved: the maximum number of VMs in the pool must be at least 1.', 'danger', 'poolSettingsStatus');
    // Placement, common to every template (node empty = automatic).
    const node = $('poolNode').value.trim() || null;
    const storage = $('poolStorage').value.trim();
    const maxParallelPreparations = Number($('poolMaxParallel').value);
    if (!storage) return status('Not saved: the storage of the pool VMs is required.', 'danger', 'poolSettingsStatus');
    if (!Number.isInteger(maxParallelPreparations) || maxParallelPreparations < 1) return status('Not saved: at least 1 parallel preparation.', 'danger', 'poolSettingsStatus');
    void act(() => api('/api/windows-pool/settings', { method: 'PUT', body: JSON.stringify({
      paused: $('poolPaused').checked, proxmoxPool: proxmoxPool || null, dnsServers, vmidMin, vmidMax, maxCapacity, node, storage, maxParallelPreparations
    }) }), () => ($('poolPaused').checked ? 'Settings saved. The pool is suspended.' : 'Settings saved. The pool is active.'), 'poolSettingsStatus');
  });

  document.querySelector(`.page[data-view="${VIEW}"]`)?.addEventListener('click', async event => {
    const button = event.target.closest('[data-pool-action]');
    if (!button) return;
    const { poolAction: action, template, deployment, vm, vmid, category, scope, max } = button.dataset;
    if (action === 'cancel-lab') {
      if (await askDialog({
        title: 'Cancel deployment?',
        message: 'The lab will stop waiting for the Windows pool. It can be deployed again later.',
        confirmLabel: 'Cancel deployment', danger: true
      }) === null) return;
      return void act(() => api(`/api/lifecycle/deployments/${encodeURIComponent(deployment)}/cancel-pool-wait`, { method: 'POST' }), 'Deployment cancelled.', 'poolRequestsStatus');
    }
    if (action === 'limit') {
      const value = await askDialog({
        title: 'Change operation limit',
        message: `${CATEGORIES[category] ?? category} (${scope}). A ceiling of 0 suspends this operation.`,
        confirmLabel: 'Save limit',
        field: { label: 'New ceiling', value: max }
      });
      if (value === null) return;
      return void act(() => api('/api/windows-pool/limits', { method: 'PUT', body: JSON.stringify({ category, scope, maxActive: Number(value) }) }), 'Limit updated.', 'poolLimitsStatus');
    }
    if (action === 'destroy-vm') {
      if (await askDialog({
        title: `Destroy VM ${vmid}?`,
        message: 'This quarantined VM and its diagnosis data will be permanently deleted.',
        confirmLabel: 'Destroy VM', danger: true
      }) === null) return;
      return void act(() => api(`/api/windows-pool/vms/${encodeURIComponent(vm)}/destroy`, { method: 'POST' }), `VM ${vmid} will be destroyed by the pool worker.`, 'poolQuarantineStatus');
    }
    if (action === 'timeline') {
      return void api(`/api/windows-pool/vms/${encodeURIComponent(vm)}/timeline`).then(timeline => {
        const element = $('poolTimeline');
        element.innerHTML = `<h4>Timeline of VM ${timeline.vm.vmid}</h4><ol>${timeline.events.map(e =>
          `<li><time>${escapeHtml(new Date(e.at).toLocaleString())}</time> — ${escapeHtml(e.from ?? '·')} → <strong>${escapeHtml(e.to)}</strong>${e.detail?.code ? ` (${escapeHtml(e.detail.code)})` : ''}</li>`).join('')}</ol>`;
        element.hidden = false;
      }).catch(error => status(error.message, 'danger'));
    }
  });
}

function activate(view) {
  active = view === VIEW;
  clearInterval(timer);
  if (active) {
    void load();
    timer = setInterval(() => { if (!document.hidden) void load({ quiet: true }); }, REFRESH_MS);
  }
}

window.addEventListener('labfactory:view', event => activate(event.detail?.view));
bind();
// Page opened directly (#/admin-windows-pool): the app.js event may have fired before this module loaded.
if (location.hash.replace(/^#\/?/, '').split('/')[0] === VIEW) activate(VIEW);

export { load, render };
