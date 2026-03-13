const state = {
  templates: [],
  blueprints: [],
  lifecycleLabs: [],
  currentBlueprint: createEmptyBlueprint()
};

const navButtons = Array.from(document.querySelectorAll('.nav button'));
const pages = Array.from(document.querySelectorAll('.page'));
const globalStatus = document.getElementById('globalStatus');

const blueprintList = document.getElementById('blueprintList');
const modelList = document.getElementById('modelList');
const lifecycleList = document.getElementById('lifecycleList');
const templatePalette = document.getElementById('templatePalette');
const templateCount = document.getElementById('templateCount');
const vmCount = document.getElementById('vmCount');
const canvasVmList = document.getElementById('canvasVmList');
const dropzone = document.getElementById('dropzone');
const editorTitle = document.getElementById('editorTitle');

const blueprintNameInput = document.getElementById('blueprintName');
const blueprintDescriptionInput = document.getElementById('blueprintDescription');
const saveBlueprintButton = document.getElementById('saveBlueprintButton');
const newBlueprintButton = document.getElementById('newBlueprintButton');
const templateForm = document.getElementById('templateForm');

const queueTableBody = document.getElementById('queueTableBody');
const workersContainer = document.getElementById('workers');
const terraformButton = document.getElementById('terraformJobButton');
const terraformStatus = document.getElementById('terraformJobStatus');
const terraformSettingsForm = document.getElementById('terraformSettingsForm');
const terraformSettingsStatus = document.getElementById('terraformSettingsStatus');
const resetSettingsButton = document.getElementById('resetSettingsButton');

const statusTimers = new WeakMap();

function createEmptyBlueprint() {
  return {
    id: null,
    name: '',
    description: '',
    status: 'draft',
    vms: []
  };
}

function showMessage(target, message, status = 'success', timeout = 3200) {
  target.textContent = message;
  target.dataset.state = status;
  target.hidden = false;
  const existingTimer = statusTimers.get(target);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = window.setTimeout(() => {
    target.hidden = true;
  }, timeout);
  statusTimers.set(target, timer);
}

function setActiveView(view) {
  navButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  pages.forEach(page => {
    page.hidden = page.dataset.view !== view;
  });
}

function syncBlueprintFields() {
  blueprintNameInput.value = state.currentBlueprint.name;
  blueprintDescriptionInput.value = state.currentBlueprint.description;
  editorTitle.textContent = state.currentBlueprint.id
    ? `Editing ${state.currentBlueprint.name || 'blueprint'}`
    : 'New blueprint';
}

function renderBlueprintList() {
  if (!state.blueprints.length) {
    blueprintList.innerHTML = '<p class="placeholder">No blueprints saved yet.</p>';
    return;
  }

  blueprintList.innerHTML = state.blueprints
    .map(
      blueprint => `
        <article class="blueprint-item ${blueprint.id === state.currentBlueprint.id ? 'active' : ''}" data-blueprint-id="${blueprint.id}">
          <div class="panel-head">
            <div>
              <strong>${escapeHtml(blueprint.name)}</strong>
              <p class="muted">${escapeHtml(blueprint.description || 'No description')}</p>
            </div>
            <div class="inline-actions">
              <span class="pill">${blueprint.vmCount} VM</span>
              <button class="icon-btn delete-blueprint-button" type="button" data-blueprint-id="${blueprint.id}" aria-label="Delete blueprint">×</button>
            </div>
          </div>
          <div class="template-meta">
            <span class="mini-pill">${new Date(blueprint.updatedAt).toLocaleString()}</span>
          </div>
        </article>
      `
    )
    .join('');

  blueprintList.querySelectorAll('[data-blueprint-id]').forEach(node => {
    node.addEventListener('click', async () => {
      await loadBlueprint(node.dataset.blueprintId);
    });
  });

  blueprintList.querySelectorAll('.delete-blueprint-button').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await fetchJson(`/api/blueprints/${button.dataset.blueprintId}`, { method: 'DELETE' });
        if (state.currentBlueprint.id === button.dataset.blueprintId) {
          resetBlueprintEditor();
        }
        await loadBlueprints();
        await refreshLifecycleLabs();
        showMessage(globalStatus, 'Blueprint deleted.', 'success');
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderTemplates() {
  templateCount.textContent = `${state.templates.length} model${state.templates.length > 1 ? 's' : ''}`;

  renderModelList();

  if (!state.templates.length) {
    templatePalette.innerHTML = '<p class="placeholder">No VM models yet.</p>';
    return;
  }

  templatePalette.innerHTML = state.templates
    .map(
      template => `
        <article class="template-card" draggable="true" data-template-id="${template.id}">
          <div class="template-top">
            <div class="template-badge">${escapeHtml(getModelBadge(template.name))}</div>
            <div class="template-meta">
              <span class="mini-pill">VMID ${template.proxmoxTemplateVmid}</span>
              <span class="mini-pill">${template.fullClone ? 'full clone' : 'linked clone'}</span>
            </div>
          </div>
          <div>
            <strong>${escapeHtml(template.name)}</strong>
            <p class="muted">${escapeHtml(template.description || 'Reusable VM model')}</p>
          </div>
        </article>
      `
    )
    .join('');

  templatePalette.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('dragstart', event => {
      card.classList.add('dragging');
      event.dataTransfer.setData('text/plain', card.dataset.templateId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
  });
}

function renderModelList() {
  if (!state.templates.length) {
    modelList.innerHTML = '<p class="placeholder">No VM models registered yet.</p>';
    return;
  }

  modelList.innerHTML = state.templates
    .map(
      template => `
        <article class="blueprint-item">
          <div class="panel-head">
            <div>
              <strong>${escapeHtml(template.name)}</strong>
              <p class="muted">${escapeHtml(template.description || 'No description')}</p>
            </div>
            <span class="pill">VMID ${template.proxmoxTemplateVmid}</span>
          </div>
          <div class="panel-head">
            <div class="template-meta">
              <span class="mini-pill">${template.fullClone ? 'full clone' : 'linked clone'}</span>
            </div>
            <button class="icon-btn delete-model-button" type="button" data-template-id="${template.id}" aria-label="Delete VM model">×</button>
          </div>
        </article>
      `
    )
    .join('');

  modelList.querySelectorAll('.delete-model-button').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await fetchJson(`/api/templates/${button.dataset.templateId}`, { method: 'DELETE' });
        if (state.currentBlueprint.vms.some(vm => vm.templateId === button.dataset.templateId)) {
          state.currentBlueprint.vms = state.currentBlueprint.vms.filter(
            vm => vm.templateId !== button.dataset.templateId
          );
          renderCanvas();
        }
        await loadTemplates();
        showMessage(globalStatus, 'VM model deleted.', 'success');
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderCanvas() {
  vmCount.textContent = `${state.currentBlueprint.vms.length} VM`;

  if (!state.currentBlueprint.vms.length) {
    canvasVmList.innerHTML = '<p class="placeholder">The lab is empty. Drag a template into the workspace.</p>';
    return;
  }

  canvasVmList.innerHTML = state.currentBlueprint.vms
    .map((vm, index) => {
      const template = state.templates.find(item => item.id === vm.templateId);
      return `
        <article class="vm-card" data-vm-id="${vm.id}">
          <div class="vm-top">
            <div style="display:flex; gap:12px; align-items:center;">
              <div class="vm-badge">${escapeHtml(getModelBadge(template?.name || 'VM'))}</div>
              <div>
                <strong>${escapeHtml(template?.name || 'Unknown template')}</strong>
                <p class="muted">${escapeHtml(template?.description || '')}</p>
                <div class="template-meta">
                  <span class="mini-pill">VMID ${template?.proxmoxTemplateVmid ?? 'n/a'}</span>
                  <span class="mini-pill">${template?.fullClone ? 'full clone' : 'linked clone'}</span>
                </div>
              </div>
            </div>
            <span class="pill">VM ${index + 1}</span>
          </div>
          <div class="vm-controls">
            <label class="field">
              <span>Instance name</span>
              <input type="text" data-field="name" value="${escapeHtmlAttr(vm.name)}">
            </label>
            <div class="vm-actions">
              <button class="icon-btn" type="button" data-action="remove" aria-label="Remove VM">×</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  canvasVmList.querySelectorAll('.vm-card').forEach(card => {
    const vmId = card.dataset.vmId;
    card.querySelector('[data-field="name"]').addEventListener('input', event => {
      updateVm(vmId, vm => {
        vm.name = event.target.value;
      });
    });
    card.querySelector('[data-action="remove"]').addEventListener('click', () => {
      state.currentBlueprint.vms = state.currentBlueprint.vms.filter(vm => vm.id !== vmId);
      renderCanvas();
    });
  });
}

function renderLifecycleLabs() {
  if (!lifecycleList) return;
  if (!state.lifecycleLabs.length) {
    lifecycleList.innerHTML = '<p class="placeholder">No saved labs available yet.</p>';
    return;
  }

  lifecycleList.innerHTML = state.lifecycleLabs
    .map(
      lab => {
        const actions = resolveLifecycleActions(lab.lifecycle.status);
        const actionMarkup = actions.busy
          ? '<span class="loading-spinner" aria-hidden="true"></span>'
          : actions.items
              .map(
                action =>
                  `<button class="icon-btn lifecycle-action" type="button" data-action="${action.action}" data-blueprint-id="${lab.id}" aria-label="${action.label}" title="${action.label}">${action.icon}</button>`
              )
              .join('');

        return `
        <article class="blueprint-item">
          <div class="panel-head">
            <div>
              <strong style="display:inline-flex; align-items:center; gap:8px;">
                <span>${escapeHtml(lab.name)} (${escapeHtml(lab.lifecycle.status || 'idle')})</span>
                ${actionMarkup}
              </strong>
              <p class="muted">${escapeHtml(lab.description || 'No description')}</p>
            </div>
            <span class="pill">${lab.vmCount} VM</span>
          </div>
        </article>
      `;
      }
    )
    .join('');

  lifecycleList.querySelectorAll('.lifecycle-action').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await fetchJson(
          `/api/lifecycle/labs/${button.dataset.blueprintId}/${button.dataset.action}`,
          { method: 'POST' }
        );
        await refreshLifecycleLabs();
        await refreshQueues();
        showMessage(
          globalStatus,
          `${button.dataset.action[0].toUpperCase()}${button.dataset.action.slice(1)} queued with job ${result.jobId}.`,
          'success'
        );
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function resolveLifecycleActions(status) {
  if (['queued', 'deploying', 'starting', 'stopping', 'destroying'].includes(status)) {
    return { busy: true, items: [] };
  }
  if (status === 'running') {
    return { busy: false, items: [{ action: 'stop', icon: '■', label: 'Stop lab' }] };
  }
  if (status === 'stopped') {
    return {
      busy: false,
      items: [
        { action: 'start', icon: '▶', label: 'Start lab' },
        { action: 'destroy', icon: '✕', label: 'Destroy deployment' }
      ]
    };
  }
  if (status === 'deployed') {
    return { busy: false, items: [{ action: 'stop', icon: '■', label: 'Stop lab' }] };
  }
  return { busy: false, items: [{ action: 'deploy', icon: '⬆', label: 'Deploy lab' }] };
}

function updateVm(vmId, mutator) {
  state.currentBlueprint.vms = state.currentBlueprint.vms.map(vm => {
    if (vm.id !== vmId) return vm;
    const next = {
      ...vm,
      config: { ...vm.config }
    };
    mutator(next);
    return next;
  });
}

function addVmFromTemplate(templateId) {
  const template = state.templates.find(item => item.id === templateId);
  if (!template) return;

  const instanceCount = state.currentBlueprint.vms.filter(vm => vm.templateId === templateId).length + 1;
  state.currentBlueprint.vms.push({
    id: crypto.randomUUID(),
    templateId,
    name: `${template.name} ${instanceCount}`,
    config: {}
  });
  renderCanvas();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || firstFieldError(payload.errors) || 'Request failed');
  }
  return payload;
}

function firstFieldError(errors) {
  if (!errors || typeof errors !== 'object') return '';
  return Object.values(errors).flat().find(Boolean) || '';
}

async function loadTemplates() {
  state.templates = await fetchJson('/api/templates');
  renderTemplates();
}

async function loadBlueprints() {
  state.blueprints = await fetchJson('/api/blueprints');
  renderBlueprintList();
}

async function refreshLifecycleLabs() {
  state.lifecycleLabs = await fetchJson('/api/lifecycle/labs');
  renderLifecycleLabs();
}

async function loadBlueprint(blueprintId) {
  const blueprint = await fetchJson(`/api/blueprints/${blueprintId}`);
  state.currentBlueprint = {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description || '',
    status: blueprint.status,
    vms: blueprint.vms.map(vm => ({
      id: vm.id,
      templateId: vm.template.id,
      name: vm.name,
      config: { ...(vm.config || {}) }
    }))
  };
  syncBlueprintFields();
  renderCanvas();
  renderBlueprintList();
  showMessage(globalStatus, 'Blueprint loaded.', 'success');
}

function resetBlueprintEditor() {
  state.currentBlueprint = createEmptyBlueprint();
  syncBlueprintFields();
  renderCanvas();
  renderBlueprintList();
}

async function saveBlueprint() {
  state.currentBlueprint.name = blueprintNameInput.value.trim();
  state.currentBlueprint.description = blueprintDescriptionInput.value.trim();
  state.currentBlueprint.status = 'draft';

  if (!state.currentBlueprint.name) {
    throw new Error('Blueprint name is required');
  }
  if (!state.currentBlueprint.vms.length) {
    throw new Error('A lab must contain at least one VM');
  }

  const payload = {
    name: state.currentBlueprint.name,
    description: state.currentBlueprint.description,
    status: state.currentBlueprint.status,
    vms: state.currentBlueprint.vms.map(vm => ({
      id: state.currentBlueprint.id ? vm.id : undefined,
      templateId: vm.templateId,
      name: vm.name.trim(),
      config: sanitizeConfig(vm.config)
    }))
  };

  const url = state.currentBlueprint.id
    ? `/api/blueprints/${state.currentBlueprint.id}`
    : '/api/blueprints';
  const method = state.currentBlueprint.id ? 'PUT' : 'POST';

  const blueprint = await fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  state.currentBlueprint = {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description || '',
    status: blueprint.status,
    vms: blueprint.vms.map(vm => ({
      id: vm.id,
      templateId: vm.template.id,
      name: vm.name,
      config: { ...(vm.config || {}) }
    }))
  };

  syncBlueprintFields();
  renderCanvas();
  await loadBlueprints();
  await refreshLifecycleLabs();
  showMessage(globalStatus, 'Blueprint saved.', 'success');
}

function sanitizeConfig(config) {
  return Object.fromEntries(
    Object.entries(config || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  );
}

function getModelBadge(name) {
  const parts = String(name || 'VM')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map(part => part[0]).join('').toUpperCase() || 'VM';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value ?? '');
}

function fillSettingsForm(settings) {
  Object.entries(settings).forEach(([key, value]) => {
    const field = terraformSettingsForm.elements[key];
    if (!field) return;
    if (field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else {
      field.value = value ?? '';
    }
  });
}

function collectSettingsPayload() {
  const payload = {};
  Array.from(terraformSettingsForm.elements).forEach(element => {
    if (!element.name) return;
    if (element.type === 'checkbox') {
      payload[element.name] = element.checked;
      return;
    }
    if (element.type === 'number') {
      if (element.value === '') return;
      payload[element.name] = Number(element.value);
      return;
    }
    payload[element.name] = element.value;
  });
  return payload;
}

async function loadTerraformSettings() {
  try {
    const settings = await fetchJson('/api/settings/terraform');
    fillSettingsForm(settings);
  } catch (error) {
    showMessage(terraformSettingsStatus, error.message, 'danger');
  }
}

function renderWorkers(workers) {
  if (!workers.length) {
    workersContainer.innerHTML = '<p class="placeholder">No workers detected.</p>';
    return;
  }

  workersContainer.innerHTML = workers
    .map(worker => {
      const action = worker.status === 'running' ? 'pause' : 'resume';
      const lastBeat = worker.lastHeartbeat ? new Date(worker.lastHeartbeat).toLocaleTimeString() : 'n/a';
      return `
        <article class="worker-card">
          <div class="worker-top">
            <div>
              <strong>${escapeHtml(worker.name)}</strong>
              <p class="muted">Heartbeat: ${escapeHtml(lastBeat)}</p>
            </div>
            <span class="status-dot" data-state="${worker.status === 'running' ? 'running' : worker.status === 'paused' ? 'paused' : 'unknown'}"></span>
          </div>
          <div class="inline-actions">
            <span class="pill">${escapeHtml(worker.status || 'unknown')}</span>
            <button class="btn btn-ghost worker-toggle" data-worker="${worker.name}" data-action="${action}" type="button">${action}</button>
          </div>
        </article>
      `;
    })
    .join('');

  workersContainer.querySelectorAll('.worker-toggle').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await fetchJson('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            worker: button.dataset.worker,
            action: button.dataset.action
          })
        });
        await refreshWorkers();
      } catch (error) {
        showMessage(terraformStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function refreshQueues() {
  try {
    const queues = await fetchJson('/api/queues');
    queueTableBody.innerHTML = queues
      .map(
        queue => `
          <tr>
            <td>${escapeHtml(queue.name)}</td>
            <td>${queue.waiting ?? 0}</td>
            <td>${queue.active ?? 0}</td>
            <td>${queue.delayed ?? 0}</td>
            <td>${queue.completed ?? 0}</td>
            <td>${queue.failed ?? 0}</td>
          </tr>
        `
      )
      .join('');
  } catch {
    queueTableBody.innerHTML = '<tr><td colspan="6">Unable to load queues.</td></tr>';
  }
}

async function refreshWorkers() {
  try {
    const workers = await fetchJson('/api/workers');
    renderWorkers(workers);
  } catch {
    workersContainer.innerHTML = '<p class="placeholder">Unable to load workers.</p>';
  }
}

navButtons.forEach(button => {
  button.addEventListener('click', () => {
    setActiveView(button.dataset.view);
  });
});

[blueprintNameInput, blueprintDescriptionInput].forEach(input => {
  input.addEventListener('input', () => {
    state.currentBlueprint.name = blueprintNameInput.value;
    state.currentBlueprint.description = blueprintDescriptionInput.value;
    state.currentBlueprint.status = 'draft';
    syncBlueprintFields();
    renderBlueprintList();
  });
});

templateForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(templateForm);
  const payload = {
    name: String(form.get('name') || '').trim(),
    description: String(form.get('description') || '').trim(),
    proxmoxTemplateVmid: Number(form.get('proxmoxTemplateVmid') || 0),
    fullClone: form.get('fullClone') === 'on'
  };

  try {
    await fetchJson('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    templateForm.reset();
    await loadTemplates();
    showMessage(globalStatus, 'VM model created.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  }
});

newBlueprintButton.addEventListener('click', () => {
  resetBlueprintEditor();
});

saveBlueprintButton.addEventListener('click', async () => {
  saveBlueprintButton.disabled = true;
  try {
    await saveBlueprint();
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  } finally {
    saveBlueprintButton.disabled = false;
  }
});

dropzone.addEventListener('dragover', event => {
  event.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const templateId = event.dataTransfer.getData('text/plain');
  addVmFromTemplate(templateId);
});

terraformSettingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await fetchJson('/api/settings/terraform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettingsPayload())
    });
    showMessage(terraformSettingsStatus, 'Settings saved.', 'success');
    await loadTerraformSettings();
  } catch (error) {
    showMessage(terraformSettingsStatus, error.message, 'danger');
  }
});

resetSettingsButton.addEventListener('click', () => {
  loadTerraformSettings();
});

terraformButton.addEventListener('click', async () => {
  terraformButton.disabled = true;
  showMessage(terraformStatus, 'Queueing Terraform job...', 'warning');
  try {
    const payload = await fetchJson('/api/jobs/terraform', { method: 'POST' });
    showMessage(terraformStatus, `Job ${payload.jobId} queued in ${payload.queue}.`, 'success');
    await refreshQueues();
  } catch (error) {
    showMessage(terraformStatus, error.message, 'danger');
  } finally {
    terraformButton.disabled = false;
  }
});

async function bootstrap() {
  setActiveView('blueprint');
  syncBlueprintFields();
  renderCanvas();
  await Promise.all([
    loadTemplates(),
    loadBlueprints(),
    refreshLifecycleLabs(),
    loadTerraformSettings(),
    refreshQueues(),
    refreshWorkers()
  ]);
  setInterval(() => {
    refreshQueues();
    refreshWorkers();
    refreshLifecycleLabs();
  }, 5000);
}

bootstrap().catch(error => {
  showMessage(globalStatus, error.message || 'Unable to initialise dashboard', 'danger', 5000);
});
