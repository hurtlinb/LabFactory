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

function status(message, kind = 'success') {
  const element = $('poolStatus');
  if (!element) return;
  element.textContent = message;
  element.className = `status-message ${kind}`;
  element.hidden = !message;
  if (message && kind === 'success') setTimeout(() => { if (element.textContent === message) element.hidden = true; }, 4000);
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
  $('poolVmidRange').textContent = `Dedicated VMID range: ${s.vmidMin}–${s.vmidMax} (never used by Terraform labs).`;
}

function templateState(t) {
  if (!t.configured) return '<span class="muted">Not configured</span>';
  const c = t.config;
  const qualification = c.qualified
    ? `Qualified (rev. ${c.revision})`
    : `<strong>Not qualified</strong> for rev. ${c.revision}`;
  return `${c.enabled ? '<strong>Enabled</strong>' : 'Disabled'} · ${qualification}`;
}

function renderTemplates() {
  const rows = overview.templates.map(t => {
    const c = t.config;
    const counts = t.counts;
    const actions = [
      `<button type="button" class="btn btn-ghost" data-pool-action="configure" data-template="${escapeHtml(t.templateId)}">${t.configured ? 'Edit' : 'Configure'}</button>`
    ];
    if (t.configured && !c.qualified) actions.push(`<button type="button" class="btn btn-ghost" data-pool-action="qualify" data-template="${escapeHtml(t.templateId)}">Mark qualified</button>`);
    if (t.configured && c.qualified && !c.enabled) actions.push(`<button type="button" class="btn btn-ghost" data-pool-action="enable" data-template="${escapeHtml(t.templateId)}">Enable</button>`);
    if (t.configured && c.enabled) actions.push(`<button type="button" class="btn btn-ghost" data-pool-action="disable" data-template="${escapeHtml(t.templateId)}">Disable</button>`);
    return `<tr>
      <th scope="row">${escapeHtml(t.name)}<br><span class="muted">Proxmox ${escapeHtml(c?.sourceTemplateVmid ?? t.proxmoxTemplateVmid)}${c ? ` · ${escapeHtml(c.node)}/${escapeHtml(c.storage)}` : ''}</span></th>
      <td>${templateState(t)}</td>
      <td>${counts.ready}</td><td>${counts.preparing}</td><td>${counts.reserved}</td><td>${counts.assigned}</td>
      <td>${counts.quarantined ? `<strong>${counts.quarantined}</strong>` : 0}</td>
      <td>${c ? `${c.readyTarget} / ${c.maxCapacity}` : '—'}</td>
      <td class="inline-actions">${actions.join('')}</td>
    </tr>`;
  });
  $('poolTemplatesBody').innerHTML = rows.join('') || '<tr><td colspan="9" class="muted">No Windows template.</td></tr>';
}

function renderRequests() {
  const rows = overview.requests.map(r => {
    const missing = r.demand.filter(d => d.missing > 0).map(d => `${d.missing} × ${escapeHtml(templateName(d.templateId))}`).join(', ');
    const label = `${escapeHtml(r.blueprintName ?? 'Lab')} — ${escapeHtml(r.classroomName ?? '')}${r.deploymentNumber != null ? ` #${r.deploymentNumber}` : ''}`;
    return `<tr>
      <th scope="row">${label}<br><span class="muted">${r.kind === 'redeploy-workstation' ? 'Workstation redeploy' : 'Deployment'}</span></th>
      <td>${r.status === 'reserved' ? 'VMs reserved, being configured' : 'Waiting'}</td>
      <td>${escapeHtml(REASONS[r.blockedReason] ?? r.blockedReason ?? '—')}</td>
      <td>${missing || '—'}</td>
      <td>${formatSince(r.createdAt)}</td>
      <td>${r.status === 'waiting_for_pool' && r.deploymentStatus === 'waiting_for_pool'
        ? `<button type="button" class="btn btn-ghost" data-pool-action="cancel-lab" data-deployment="${escapeHtml(r.deploymentId)}">Cancel lab</button>` : ''}</td>
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

function openTemplateForm(templateId) {
  const t = overview.templates.find(item => item.templateId === templateId);
  const c = t?.config;
  $('poolTemplateId').value = templateId;
  $('poolTemplateFormTitle').textContent = `Pool configuration — ${t?.name ?? ''}`;
  $('poolSourceVmid').value = c?.sourceTemplateVmid ?? t?.proxmoxTemplateVmid ?? '';
  $('poolNode').value = c?.node ?? '';
  $('poolStorage').value = c?.storage ?? '';
  $('poolReadyTarget').value = c?.readyTarget ?? 2;
  $('poolMaxCapacity').value = c?.maxCapacity ?? 4;
  $('poolMaxParallel').value = c?.maxParallelPreparations ?? 2;
  $('poolTemplateForm').hidden = false;
  $('poolSourceVmid').focus();
}

async function act(fn, success) {
  try {
    const result = await fn();
    overview = result?.overview ?? (result?.templates ? result : overview);
    render();
    if (success) status(typeof success === 'function' ? success(result) : success);
    await load({ quiet: true });
  } catch (error) {
    status(error.message, 'danger');
  }
}

function bind() {
  $('poolRefreshButton')?.addEventListener('click', () => load());
  $('poolSettingsForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const dnsServers = $('poolDnsServers').value.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
    const proxmoxPool = $('poolProxmoxPool').value.trim();
    void act(() => api('/api/windows-pool/settings', { method: 'PUT', body: JSON.stringify({
      paused: $('poolPaused').checked, proxmoxPool: proxmoxPool || null, dnsServers
    }) }), 'Settings saved.');
  });
  $('poolTemplateForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const templateId = $('poolTemplateId').value;
    const number = id => Number($(id).value);
    void act(() => api(`/api/windows-pool/templates/${encodeURIComponent(templateId)}`, { method: 'PUT', body: JSON.stringify({
      sourceTemplateVmid: number('poolSourceVmid'), node: $('poolNode').value.trim(), storage: $('poolStorage').value.trim(),
      readyTarget: number('poolReadyTarget'), maxCapacity: number('poolMaxCapacity'), maxParallelPreparations: number('poolMaxParallel')
    }) }), result => {
      $('poolTemplateForm').hidden = true;
      return result.newRevision ? 'New revision: the template is disabled until it is qualified again.' : 'Template configuration saved.';
    });
  });
  $('poolTemplateCancel')?.addEventListener('click', () => { $('poolTemplateForm').hidden = true; });

  document.querySelector(`.page[data-view="${VIEW}"]`)?.addEventListener('click', event => {
    const button = event.target.closest('[data-pool-action]');
    if (!button) return;
    const { poolAction: action, template, deployment, vm, vmid, category, scope, max } = button.dataset;
    if (action === 'configure') return openTemplateForm(template);
    if (action === 'qualify') {
      const note = window.prompt('Qualification of the current revision (preparation without network, assignment, WinRM and persistence after reboot verified). Optional note:', '');
      if (note === null) return;
      return void act(() => api(`/api/windows-pool/templates/${encodeURIComponent(template)}/qualify`, { method: 'POST', body: JSON.stringify({ note }) }), 'Revision marked as qualified.');
    }
    if (action === 'enable' || action === 'disable') {
      const enabled = action === 'enable';
      if (!enabled && !window.confirm('Disable this template? Labs waiting for it will wait; labs already deployed are not affected.')) return;
      return void act(() => api(`/api/windows-pool/templates/${encodeURIComponent(template)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
        enabled ? 'Template enabled: new labs will use the pool.' : 'Template disabled.');
    }
    if (action === 'cancel-lab') {
      if (!window.confirm('Cancel this lab? It will stop waiting for the Windows pool.')) return;
      return void act(() => api(`/api/lifecycle/deployments/${encodeURIComponent(deployment)}/cancel-pool-wait`, { method: 'POST' }), 'Lab cancelled.');
    }
    if (action === 'limit') {
      const value = window.prompt(`New ceiling for "${CATEGORIES[category] ?? category}" (${scope}), 0 suspends this operation:`, max);
      if (value === null) return;
      return void act(() => api('/api/windows-pool/limits', { method: 'PUT', body: JSON.stringify({ category, scope, maxActive: Number(value) }) }), 'Limit updated.');
    }
    if (action === 'destroy-vm') {
      if (!window.confirm(`Destroy quarantined VM ${vmid}? Its diagnosis data will be lost.`)) return;
      return void act(() => api(`/api/windows-pool/vms/${encodeURIComponent(vm)}/destroy`, { method: 'POST' }), `VM ${vmid} will be destroyed by the pool worker.`);
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
