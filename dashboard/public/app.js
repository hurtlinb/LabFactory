const state = {
  classrooms: [],
  templates: [],
  blueprints: [],
  deployments: [],
  teachers: [],
  courses: [],
  editingTemplateId: null,
  editingClassroomId: null,
  isBlueprintWorkspaceVisible: false,
  isTemplateEditorVisible: false,
  isClassroomEditorVisible: false,
  timezoneOptions: {
    windows: [],
    linux: []
  },
  terraformSettings: {},
  auth: {
    enabled: false
  },
  currentUser: null,
  activeDeploymentDetailsId: null,
  currentBlueprint: createEmptyBlueprint()
};

const navButtons = Array.from(document.querySelectorAll('.nav button'));
const pages = Array.from(document.querySelectorAll('.page'));
const globalStatus = document.getElementById('globalStatus');

const blueprintList = document.getElementById('blueprintList');
const blueprintWorkspace = document.getElementById('blueprintWorkspace');
const modelList = document.getElementById('modelList');
const classroomList = document.getElementById('classroomList');
const lifecycleList = document.getElementById('lifecycleList');
const templatePalette = document.getElementById('templatePalette');
const vmCount = document.getElementById('vmCount');
const canvasVmList = document.getElementById('canvasVmList');
const dropzone = document.getElementById('dropzone');

const blueprintNameInput = document.getElementById('blueprintName');
const blueprintDescriptionInput = document.getElementById('blueprintDescription');
const blueprintCourseIdInput = document.getElementById('blueprintCourseId');
const blueprintWindowsAdminPasswordInput = document.getElementById('blueprintWindowsAdminPassword');
const blueprintLinuxDefaultUsernameInput = document.getElementById('blueprintLinuxDefaultUsername');
const saveBlueprintButton = document.getElementById('saveBlueprintButton');
const newBlueprintButton = document.getElementById('newBlueprintButton');
const newTemplateButton = document.getElementById('newTemplateButton');
const templateForm = document.getElementById('templateForm');
const templateSubmitButton = document.getElementById('templateSubmitButton');
const cancelTemplateEditButton = document.getElementById('cancelTemplateEditButton');
const templateEditorPanel = document.getElementById('templateEditorPanel');
const newClassroomButton = document.getElementById('newClassroomButton');
const classroomForm = document.getElementById('classroomForm');
const classroomEditorPanel = document.getElementById('classroomEditorPanel');
const classroomSubmitButton = document.getElementById('classroomSubmitButton');
const cancelClassroomEditButton = document.getElementById('cancelClassroomEditButton');
const classroomStartingSubnetInput = classroomForm?.elements?.startingSubnet ?? null;
const classroomNetworkGatewayInput = classroomForm?.elements?.networkGateway ?? null;
const deploymentForm = document.getElementById('deploymentForm');
const deploymentBlueprintSelect = document.getElementById('deploymentBlueprintSelect');
const deploymentClassroomSelect = document.getElementById('deploymentClassroomSelect');
const deploymentDetailsDialog = document.getElementById('deploymentDetailsDialog');
const deploymentDetailsTitle = document.getElementById('deploymentDetailsTitle');
const deploymentVmDetailsList = document.getElementById('deploymentVmDetailsList');
const deploymentDetailsStatus = document.getElementById('deploymentDetailsStatus');
const closeDeploymentDetailsButton = document.getElementById('closeDeploymentDetailsButton');
const vmCustomizationDialog = document.getElementById('vmCustomizationDialog');
const vmCustomizationTitle = document.getElementById('vmCustomizationTitle');
const vmCustomizationForm = document.getElementById('vmCustomizationForm');
const vmCustomizationValueInput = document.getElementById('vmCustomizationValue');
const vmCustomizationCancelButton = document.getElementById('vmCustomizationCancelButton');
const vmIpDialog = document.getElementById('vmIpDialog');
const vmIpForm = document.getElementById('vmIpForm');
const vmIpValueInput = document.getElementById('vmIpValue');
const vmIpCancelButton = document.getElementById('vmIpCancelButton');
const vmIpHelp = document.getElementById('vmIpHelp');
const vmIpSubmitButton = document.getElementById('vmIpSubmitButton');
const vmTimezoneDialog = document.getElementById('vmTimezoneDialog');
const vmTimezoneForm = document.getElementById('vmTimezoneForm');
const vmTimezoneValueSelect = document.getElementById('vmTimezoneValue');
const vmTimezoneCancelButton = document.getElementById('vmTimezoneCancelButton');

const queueTableBody = document.getElementById('queueTableBody');
const jobsTableBody = document.getElementById('jobsTableBody');
const workersContainer = document.getElementById('workers');
const terraformStatus = document.getElementById('terraformJobStatus');
const terraformSettingsForm = document.getElementById('terraformSettingsForm');
const terraformSettingsStatus = document.getElementById('terraformSettingsStatus');
const courseList = document.getElementById('courseList');
const courseForm = document.getElementById('courseForm');
const courseSubmitButton = document.getElementById('courseSubmitButton');
const refreshLabsStateButton = document.getElementById('refreshLabsStateButton');
const clearJobHistoryButton = document.getElementById('clearJobHistoryButton');
const cleanOrphanedDisksButton = document.getElementById('cleanOrphanedDisksButton');
const settingsStatus = document.getElementById('settingsStatus');
const dangerZoneStatus = document.getElementById('dangerZoneStatus');
const postgresStatusIndicator = document.getElementById('postgresStatusIndicator');
const postgresStatusLabel = document.getElementById('postgresStatusLabel');
const proxmoxStatusIndicator = document.getElementById('proxmoxStatusIndicator');
const proxmoxStatusLabel = document.getElementById('proxmoxStatusLabel');
const terraformWorkerStatusIndicator = document.getElementById('terraformWorkerStatusIndicator');
const terraformWorkerStatusLabel = document.getElementById('terraformWorkerStatusLabel');
const ansibleWorkerStatusIndicator = document.getElementById('ansibleWorkerStatusIndicator');
const ansibleWorkerStatusLabel = document.getElementById('ansibleWorkerStatusLabel');
const appVersion = document.getElementById('appVersion');
const teacherList = document.getElementById('teacherList');
const userSession = document.getElementById('userSession');
const userSessionName = document.getElementById('userSessionName');
const userSessionMeta = document.getElementById('userSessionMeta');
const logoutLink = document.getElementById('logoutLink');

const statusTimers = new WeakMap();
let pendingVmCustomization = null;
let pendingVmIpPrompt = null;
let pendingVmTimezonePrompt = null;
let activeDragItem = null;

const DEFAULT_WINDOWS_TIMEZONE = 'W. Europe Standard Time';
const DEFAULT_LINUX_TIMEZONE = 'Europe/Zurich';
const FALLBACK_WINDOWS_TIMEZONE_OPTIONS = [
  {
    id: 'W. Europe Standard Time',
    label: '(UTC+01:00) Amsterdam, Berlin, Berne, Rome, Stockholm, Vienna'
  }
];
const FALLBACK_LINUX_TIMEZONE_OPTIONS = [
  {
    id: DEFAULT_LINUX_TIMEZONE,
    label: DEFAULT_LINUX_TIMEZONE
  }
];

const PAGE_TITLES = {
  'dashboard':      { title: 'Dashboard',   breadcrumb: 'LabFactory' },
  'blueprint':      { title: 'Blueprints',  breadcrumb: 'Labs' },
  'lifecycle':      { title: 'Lifecycle',   breadcrumb: 'Labs' },
  'admin-users':    { title: 'Users',       breadcrumb: 'Administration' },
  'admin-courses':  { title: 'Courses',     breadcrumb: 'Administration' },
  'models':         { title: 'VM Models',   breadcrumb: 'Administration' },
  'classrooms':     { title: 'Classrooms',  breadcrumb: 'Administration' },
  'admin-settings': { title: 'Settings',    breadcrumb: 'Administration' },
  'admin-queues':   { title: 'Jobs',        breadcrumb: 'Administration' },
};

function getDragItemType(dataTransfer) {
  if (activeDragItem?.type) {
    return activeDragItem.type;
  }
  if (!dataTransfer) return '';
  const types = Array.from(dataTransfer.types || []);
  if (types.includes('application/x-labfactory-customization-key')) {
    return 'customization';
  }
  if (types.includes('application/x-labfactory-item-type')) {
    return dataTransfer.getData('application/x-labfactory-item-type') || '';
  }
  return '';
}

function createEmptyBlueprint() {
  return {
    id: null,
    name: '',
    description: '',
    status: 'draft',
    courseId: '',
    windowsAdminPassword: '',
    linuxDefaultUsername: 'ubuntu',
    vms: []
  };
}

function showMessage(target, message, status = 'success', timeout = 3200) {
  if (target === globalStatus && timeout === 3200) {
    timeout = 3000;
  }
  target.textContent = message;
  target.dataset.state = status;
  target.hidden = false;
  target.classList.toggle('toast-message', target === globalStatus);
  const existingTimer = statusTimers.get(target);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = window.setTimeout(() => {
    target.hidden = true;
    if (target === globalStatus) {
      target.classList.remove('toast-message');
    }
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
  const info = PAGE_TITLES[view];
  if (info) {
    const titleEl = document.getElementById('pageTitle');
    const breadcrumbEl = document.getElementById('pageBreadcrumb');
    if (titleEl) titleEl.textContent = info.title;
    if (breadcrumbEl) breadcrumbEl.textContent = info.breadcrumb;
  }
  if (view !== 'blueprint') {
    state.isBlueprintWorkspaceVisible = false;
    renderBlueprintWorkspace();
  }
  if (view !== 'models') {
    resetTemplateForm();
  }
  if (view !== 'classrooms') {
    resetClassroomForm();
  }
}

function syncBlueprintFields() {
  blueprintNameInput.value = state.currentBlueprint.name;
  blueprintDescriptionInput.value = state.currentBlueprint.description;
  if (blueprintCourseIdInput) {
    blueprintCourseIdInput.value = state.currentBlueprint.courseId || '';
  }
  if (blueprintWindowsAdminPasswordInput) {
    blueprintWindowsAdminPasswordInput.value = state.currentBlueprint.windowsAdminPassword || '';
  }
  if (blueprintLinuxDefaultUsernameInput) {
    blueprintLinuxDefaultUsernameInput.value = state.currentBlueprint.linuxDefaultUsername || 'ubuntu';
  }
}

function renderBlueprintWorkspace() {
  if (blueprintWorkspace) {
    blueprintWorkspace.hidden = !state.isBlueprintWorkspaceVisible;
  }
}

function renderTemplateEditor() {
  if (templateEditorPanel) {
    templateEditorPanel.hidden = !state.isTemplateEditorVisible;
  }
}

function renderClassroomEditor() {
  if (classroomEditorPanel) {
    classroomEditorPanel.hidden = !state.isClassroomEditorVisible;
  }
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
            <div class="blueprint-summary">
              <strong>${blueprint.course ? `${escapeHtml(String(blueprint.course.courseNumber))} - ` : ''}${escapeHtml(blueprint.name)}</strong>
              <p class="muted">${escapeHtml(blueprint.description || 'No description')}</p>
            </div>
            <div class="inline-actions">
              ${renderTeacherBadge(blueprint.teacher || { email: blueprint.teacherEmail })}
              <span class="mini-pill">${new Date(blueprint.updatedAt).toLocaleString()}</span>
              <span class="pill">${blueprint.vmCount} VM</span>
              <button class="icon-btn delete-blueprint-button" type="button" data-blueprint-id="${blueprint.id}" aria-label="Delete blueprint">×</button>
            </div>
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

function renderDeploymentSelectors() {
  if (deploymentBlueprintSelect) {
    const selected = deploymentBlueprintSelect.value;
    deploymentBlueprintSelect.innerHTML =
      '<option value="">Select a blueprint</option>' +
      state.blueprints
        .map(
          blueprint =>
            `<option value="${blueprint.id}">${blueprint.course ? `${escapeHtml(String(blueprint.course.courseNumber))} - ` : ''}${escapeHtml(blueprint.name)}</option>`
        )
        .join('');
    deploymentBlueprintSelect.value = selected;
  }

  if (deploymentClassroomSelect) {
    const selected = deploymentClassroomSelect.value;
    deploymentClassroomSelect.innerHTML =
      '<option value="">Select a classroom</option>' +
      state.classrooms
        .map(classroom => `<option value="${classroom.id}">${escapeHtml(classroom.name)}</option>`)
        .join('');
    deploymentClassroomSelect.value = selected;
  }
}

function renderBlueprintCourseOptions() {
  if (!blueprintCourseIdInput) return;
  const selected = state.currentBlueprint.courseId || blueprintCourseIdInput.value || '';
  blueprintCourseIdInput.innerHTML =
    '<option value="">Select a course</option>' +
    state.courses
      .map(course => `<option value="${course.id}">#${escapeHtml(String(course.courseNumber))}${course.description ? ` - ${escapeHtml(course.description)}` : ''}</option>`)
      .join('');
  blueprintCourseIdInput.value = selected;
}

function renderTeachers() {
  if (!teacherList) return;
  if (!state.teachers.length) {
    teacherList.innerHTML = '<p class="placeholder">No synchronized users yet.</p>';
    return;
  }

  teacherList.innerHTML = state.teachers
    .map(teacher => {
      const secondaryLabel = teacher.email && teacher.displayName !== teacher.email ? teacher.email : '';
      return `
        <article class="blueprint-item teacher-card">
          <div class="panel-head">
            <div>
              <strong>${escapeHtml(teacher.displayName || teacher.email || 'Unknown teacher')}</strong>
              <p class="muted">${secondaryLabel ? escapeHtml(secondaryLabel) : ''}</p>
            </div>
            <div class="inline-actions">
              ${renderTeacherBadge(teacher)}
              <span class="mini-pill">${new Date(teacher.updatedAt).toLocaleString()}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderCourses() {
  if (!courseList) return;
  if (!state.courses.length) {
    courseList.innerHTML = '<p class="placeholder">No courses registered yet.</p>';
    return;
  }

  courseList.innerHTML = state.courses
    .map(
      course => `
        <article class="blueprint-item course-card">
          <div class="panel-head">
            <div>
              <strong>Course ${escapeHtml(String(course.courseNumber))}</strong>
              <p class="muted">${escapeHtml(course.description || 'No description')}</p>
            </div>
            <div class="inline-actions">
              <span class="mini-pill">${new Date(course.updatedAt).toLocaleString()}</span>
              <button class="icon-btn delete-course-button" type="button" data-course-id="${course.id}" aria-label="Delete course">×</button>
            </div>
          </div>
        </article>
      `
    )
    .join('');

  courseList.querySelectorAll('.delete-course-button').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await fetchJson(`/api/courses/${button.dataset.courseId}`, { method: 'DELETE' });
        await loadCourses();
        showMessage(globalStatus, 'Course deleted.', 'success');
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });
}

function getOsGroup(osType) {
  if (osType === 'windows-server') return 'Server';
  if (osType === 'windows11') return 'Windows';
  return 'Linux';
}

function getOsDotClass(osType) {
  if (osType === 'windows-server') return 'dot-server';
  if (osType === 'windows11') return 'dot-win';
  return 'dot-linux';
}

function renderTemplates() {
  renderModelList();

  const groupsHtml = state.templates.length ? `
    <div class="vm-lib-group">
      <p class="vm-lib-group-label">VMs</p>
      ${state.templates.map(t => `
        <article class="vm-lib-item" draggable="true" data-template-id="${t.id}">
          <span class="vm-lib-name">${escapeHtml(t.name)}</span>
          <span class="vm-lib-vmid">${t.proxmoxTemplateVmid}</span>
        </article>`).join('')}
    </div>` : '';

  const custHtml = `
    <div class="vm-lib-group">
      <p class="vm-lib-group-label">Customization</p>
      <article class="vm-lib-cust" draggable="true" data-customization-key="name">
        <span class="vm-lib-cust-icon" aria-hidden="true">${getCustomizationIcon('name')}</span>
        <span class="vm-lib-cust-name">Hostname</span>
      </article>
      <article class="vm-lib-cust" draggable="true" data-customization-key="timezone">
        <span class="vm-lib-cust-icon" aria-hidden="true">${getCustomizationIcon('timezone')}</span>
        <span class="vm-lib-cust-name">Timezone</span>
      </article>
    </div>
    <p class="vm-lib-hint">→ Drag to canvas</p>`;

  templatePalette.innerHTML = `
    <div class="vm-lib-section">
      ${groupsHtml || '<p class="vm-lib-group-label">VMs</p><p class="placeholder">No VM models yet.</p>'}
      ${custHtml}
    </div>`;

  templatePalette.querySelectorAll('.vm-lib-item').forEach(card => {
    card.addEventListener('dragstart', event => {
      card.classList.add('dragging');
      activeDragItem = { type: 'template', value: card.dataset.templateId };
      event.dataTransfer.setData('application/x-labfactory-item-type', 'template');
      event.dataTransfer.setData('text/plain', card.dataset.templateId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      activeDragItem = null;
    });
  });

  templatePalette.querySelectorAll('.vm-lib-cust').forEach(card => {
    card.addEventListener('dragstart', event => {
      card.classList.add('dragging');
      activeDragItem = { type: 'customization', value: card.dataset.customizationKey };
      event.dataTransfer.setData('application/x-labfactory-item-type', 'customization');
      event.dataTransfer.setData('application/x-labfactory-customization-key', card.dataset.customizationKey);
      event.dataTransfer.setData('text/plain', card.dataset.customizationKey);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      activeDragItem = null;
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
        <article class="blueprint-item${template.id === state.editingTemplateId ? ' active' : ''}" data-template-id="${template.id}">
          <div class="panel-head">
            <div>
              <strong>${escapeHtml(template.name)}</strong>
              <p class="muted">${escapeHtml(template.description || 'No description')}</p>
            </div>
            <div class="inline-actions">
              <span class="mini-pill">${escapeHtml(getOsLabel(template.osType))}</span>
              <span class="mini-pill">${escapeHtml(getLanguageLabel(template.language))}</span>
              <span class="pill">VMID ${template.proxmoxTemplateVmid}</span>
            </div>
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
        if (state.editingTemplateId === button.dataset.templateId) {
          resetTemplateForm();
        }
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

  modelList.querySelectorAll('[data-template-id]').forEach(card => {
    card.addEventListener('click', () => {
      const template = state.templates.find(item => item.id === card.dataset.templateId);
      if (!template) return;
      populateTemplateForm(template);
    });
  });
}

function renderClassrooms() {
  if (!classroomList) return;
  if (!state.classrooms.length) {
    classroomList.innerHTML = '<p class="placeholder">No classrooms registered yet.</p>';
    return;
  }

  classroomList.innerHTML = state.classrooms
    .map(
      classroom => `
        <article class="blueprint-item${classroom.id === state.editingClassroomId ? ' active' : ''}" data-classroom-id="${classroom.id}">
          <div class="panel-head">
            <div>
              <strong>${escapeHtml(classroom.name)}</strong>
              <p class="muted">${classroom.workstationCount} workstation(s)</p>
            </div>
            <button class="icon-btn delete-classroom-button" type="button" data-classroom-id="${classroom.id}" aria-label="Delete classroom">×</button>
          </div>
          <div class="template-meta">
            <span class="mini-pill">VLAN start: ${classroom.startingVlan}</span>
            <span class="mini-pill">Subnet start: ${classroom.startingSubnet}</span>
            <span class="mini-pill">Mask: ${classroom.networkVlanMask}</span>
            <span class="mini-pill">Gateway: ${classroom.networkGateway}</span>
            <span class="mini-pill">VLAN end: ${classroom.vlans[classroom.vlans.length - 1]}</span>
          </div>
          <p class="muted">Assigned VLANs: ${classroom.vlans.join(', ')}</p>
          <p class="muted">Assigned subnets: ${classroom.subnetOctets.join(', ')}</p>
        </article>
      `
    )
    .join('');

  classroomList.querySelectorAll('.delete-classroom-button').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await fetchJson(`/api/classrooms/${button.dataset.classroomId}`, { method: 'DELETE' });
        if (state.editingClassroomId === button.dataset.classroomId) {
          resetClassroomForm();
        }
        await loadClassrooms();
        showMessage(globalStatus, 'Classroom deleted.', 'success');
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });

  classroomList.querySelectorAll('[data-classroom-id]').forEach(card => {
    card.addEventListener('click', () => {
      const classroom = state.classrooms.find(item => item.id === card.dataset.classroomId);
      if (!classroom) return;
      populateClassroomForm(classroom);
    });
  });

  renderDeploymentSelectors();
}

function renderCanvas() {
  vmCount.textContent = `${state.currentBlueprint.vms.length} VM`;

  if (!state.currentBlueprint.vms.length) {
    canvasVmList.innerHTML = '<p class="placeholder">The lab is empty. Drag a template into the workspace.</p>';
    return;
  }

  canvasVmList.innerHTML = state.currentBlueprint.vms
    .map(vm => {
      const template = state.templates.find(item => item.id === vm.templateId);
      const vmPills = [];
      vmPills.push(`
        <span class="mini-pill vm-ip-pill">
          <span>IP: x.x.x.${escapeHtml(String(vm.ipLastOctet ?? '?'))}</span>
          <button class="pill-action-button" type="button" data-action="edit-ip" aria-label="Edit IP last octet" title="Edit IP last octet">✎</button>
        </span>
      `);
      if (vm.config?.customNameEnabled && String(vm.name || '').trim()) {
        vmPills.push(`
          <span class="mini-pill vm-customization-pill">
            <span>Hostname: ${escapeHtml(vm.name.trim())}</span>
            <button class="pill-action-button" type="button" data-action="remove-customization" data-customization-key="name" aria-label="Remove Hostname customization" title="Remove Hostname customization">×</button>
          </span>
        `);
      }
      if (String(vm.config?.timezone || '').trim()) {
        vmPills.push(`
          <span class="mini-pill vm-customization-pill">
            <span>Timezone: ${escapeHtml(String(vm.config.timezone).trim())}</span>
            <button class="pill-action-button" type="button" data-action="remove-customization" data-customization-key="timezone" aria-label="Remove Timezone customization" title="Remove Timezone customization">×</button>
          </span>
        `);
      }
      return `
        <article class="vm-card" data-vm-id="${vm.id}">
          <div class="vm-top">
            <div style="display:flex; gap:12px; align-items:center;">
              <div class="vm-badge template-badge-image">
                <img src="${escapeHtmlAttr(getOsLogo(template?.osType))}" alt="" aria-hidden="true">
              </div>
              <div>
                <strong>${escapeHtml(template?.name || 'Unknown template')}</strong>
              </div>
            </div>
          </div>
          <div class="vm-controls">
            <div class="vm-pills">${vmPills.join('')}</div>
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
    card.addEventListener('dragover', event => {
      if (getDragItemType(event.dataTransfer) !== 'customization') {
        return;
      }
      event.preventDefault();
      card.classList.add('dragover');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('dragover');
    });
    card.addEventListener('drop', async event => {
      const itemType = getDragItemType(event.dataTransfer);
      if (itemType !== 'customization') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove('dragover');
      const customizationKey =
        activeDragItem?.type === 'customization'
          ? activeDragItem.value
          : event.dataTransfer.getData('application/x-labfactory-customization-key');
      if (customizationKey === 'name') {
        await promptVmName(vmId);
      }
      if (customizationKey === 'timezone') {
        await promptVmTimezone(vmId);
      }
    });
    card.querySelectorAll('[data-action="remove-customization"]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (button.dataset.customizationKey === 'name') {
          updateVm(vmId, vm => {
            vm.config.customNameEnabled = false;
            vm.name = '';
          });
          renderCanvas();
        }
        if (button.dataset.customizationKey === 'timezone') {
          updateVm(vmId, vm => {
            delete vm.config.timezone;
          });
          renderCanvas();
        }
      });
    });
    card.querySelector('[data-action="edit-ip"]')?.addEventListener('click', async event => {
      event.stopPropagation();
      const vm = state.currentBlueprint.vms.find(item => item.id === vmId);
      if (!vm) return;
      const ipLastOctet = await promptVmIpLastOctet({
        initialValue: vm.ipLastOctet,
        title: 'Edit IP last octet',
        submitLabel: 'Apply'
      });
      if (ipLastOctet == null) return;
      updateVm(vmId, nextVm => {
        nextVm.ipLastOctet = ipLastOctet;
      });
      renderCanvas();
    });
    card.querySelector('[data-action="remove"]').addEventListener('click', () => {
      state.currentBlueprint.vms = state.currentBlueprint.vms.filter(vm => vm.id !== vmId);
      renderCanvas();
    });
  });
}

function renderLifecycleSteps(status) {
  const s = String(status || 'idle');

  const opMap = {
    idle:        { label: 'Not started',       cls: 'op-idle',    icon: '↺' },
    queued:      { label: 'Queued',            cls: 'op-busy',    icon: '↻' },
    deploying:   { label: 'Deploying…',        cls: 'op-busy',    icon: '↻' },
    customizing: { label: 'Configuring…',      cls: 'op-busy',    icon: '↻' },
    deployed:    { label: 'Ready to start',    cls: 'op-stopped', icon: '▶' },
    starting:    { label: 'Starting…',         cls: 'op-busy',    icon: '↻' },
    running:     { label: 'Running',           cls: 'op-running', icon: '▶' },
    mixed:       { label: 'Partially running', cls: 'op-warning', icon: '▶' },
    stopping:    { label: 'Stopping…',         cls: 'op-busy',    icon: '↻' },
    stopped:     { label: 'Stopped',           cls: 'op-stopped', icon: '■' },
    destroying:  { label: 'Destroying…',       cls: 'op-busy',    icon: '↻' },
    destroyed:   { label: 'Destroyed',         cls: 'op-idle',    icon: '✕' },
    failed:      { label: 'Failed',            cls: 'op-warning', icon: '!' },
  };
  const op = opMap[s] || { label: s, cls: 'op-idle', icon: '?' };

  const prepareState = ['queued', 'deploying', 'customizing'].includes(s) ? 'active'
    : ['deployed', 'running', 'mixed', 'starting', 'stopping', 'stopped', 'destroying', 'destroyed'].includes(s) ? 'done'
    : '';

  const activeState = ['deployed', 'running', 'mixed', 'starting', 'stopping', 'stopped'].includes(s) ? 'active'
    : ['destroying', 'destroyed'].includes(s) ? 'done'
    : '';

  const destroyState = s === 'destroying' ? 'active' : s === 'destroyed' ? 'done' : '';

  const phases = [
    {
      state: prepareState,
      icon: prepareState === 'done' ? '✓' : '↑',
      label: 'Prepare',
      sub: 'Clone + init',
      circleClass: '',
    },
    {
      state: activeState,
      icon: activeState === 'done' ? '✓' : activeState === 'active' ? op.icon : '↺',
      label: 'Active',
      sub: activeState === 'active' ? op.label : 'Start / Stop',
      circleClass: activeState === 'active' ? op.cls : '',
    },
    {
      state: destroyState,
      icon: destroyState === 'done' ? '✓' : '✕',
      label: 'Destroy',
      sub: 'Delete VMs',
      circleClass: '',
    },
  ];

  return `<div class="lc-steps">${phases.map(p => `
    <div class="lc-step ${p.state}">
      <div class="lc-circle ${p.circleClass}">${p.icon}</div>
      <div class="lc-label">${p.label}</div>
      <div class="lc-sub">${p.sub}</div>
    </div>`).join('')}</div>`;
}

function renderLifecycleLabs() {
  if (!lifecycleList) return;
  if (!state.deployments.length) {
    lifecycleList.innerHTML = '<p class="placeholder">No deployments yet.</p>';
    return;
  }

  lifecycleList.innerHTML = state.deployments
    .map(deployment => {
      const actions = resolveLifecycleActions(deployment.status);
      const canDeleteDeployment = ['idle', 'failed', 'destroyed'].includes(deployment.status);
      const hasWarning = deployment.status === 'mixed';
      const readyCount = Number(deployment.readyCount ?? deployment.customizedCount ?? 0);
      const totalVmCount = Number(deployment.totalVmCount ?? 0);

      const actionButtons = actions.busy
        ? `<span class="loading-spinner" aria-hidden="true"></span>`
        : actions.items
            .map(a => `<button class="btn lifecycle-action" type="button" data-action="${a.action}" data-deployment-id="${deployment.id}">${a.icon} ${a.label}</button>`)
            .join('');

      const deleteBtn = canDeleteDeployment
        ? `<button class="btn btn-ghost delete-deployment-button" type="button" data-deployment-id="${deployment.id}">✕ Delete</button>`
        : '';

      const s = deployment.status || 'idle';
      const statusPillClass = actions.busy ? 'status-pill-busy'
        : ['running', 'deployed'].includes(s) ? 'status-pill-running'
        : s === 'mixed' ? 'status-pill-mixed'
        : s === 'stopped' ? 'status-pill-stopped'
        : ['destroyed', 'idle'].includes(s) ? 'status-pill-destroyed'
        : '';

      return `
        <article class="panel deployment-card" data-deployment-id="${deployment.id}">
          <div class="panel-head deploy-head">
            <div>
              <p class="deploy-title">
                ${deployment.blueprint.course ? `${escapeHtml(String(deployment.blueprint.course.courseNumber))} · ` : ''}${escapeHtml(deployment.blueprint.name)}
                <span style="color:var(--muted);font-weight:400;">@</span>
                ${escapeHtml(deployment.classroom.name)}
                <span class="deploy-number">Lab #${escapeHtml(String(deployment.deploymentNumber))}</span>
                ${hasWarning ? '<span class="mini-pill warning-pill">Warning</span>' : ''}
              </p>
              <p class="deploy-meta">${totalVmCount} VMs · ${readyCount} ready · ${renderTeacherBadge(deployment.teacher || { email: deployment.teacherEmail })}</p>
            </div>
            <div class="inline-actions">
              <span class="pill ${statusPillClass}">${escapeHtml(s)}</span>
              <button class="btn btn-ghost view-details-btn" type="button" data-deployment-id="${deployment.id}">Details →</button>
            </div>
          </div>
          ${renderLifecycleSteps(deployment.status)}
          <div class="lc-actions">
            ${actionButtons}
            ${deleteBtn ? `<span class="lc-actions-spacer"></span>${deleteBtn}` : ''}
          </div>
        </article>`;
    })
    .join('');

  lifecycleList.querySelectorAll('.lifecycle-action').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        const result = await fetchJson(
          `/api/lifecycle/deployments/${button.dataset.deploymentId}/${button.dataset.action}`,
          { method: 'POST' }
        );
        await refreshLifecycleLabs();
        await refreshQueues();
        showMessage(globalStatus, `${button.dataset.action[0].toUpperCase()}${button.dataset.action.slice(1)} queued with job ${result.jobId}.`, 'success');
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });

  lifecycleList.querySelectorAll('.delete-deployment-button').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await fetchJson(`/api/lifecycle/deployments/${button.dataset.deploymentId}`, { method: 'DELETE' });
        await refreshLifecycleLabs();
        showMessage(globalStatus, 'Deployment deleted.', 'success');
      } catch (error) {
        showMessage(globalStatus, error.message, 'danger');
      } finally {
        button.disabled = false;
      }
    });
  });

  lifecycleList.querySelectorAll('.view-details-btn').forEach(btn => {
    btn.addEventListener('click', async event => {
      event.stopPropagation();
      await openDeploymentDetails(btn.dataset.deploymentId);
    });
  });
}

function renderDashboard() {
  // Metrics
  const active = state.deployments.filter(d =>
    ['running', 'deployed', 'mixed', 'starting'].includes(d.status)
  );
  const totalVms = state.deployments.reduce((s, d) => s + Number(d.totalVmCount ?? 0), 0);

  const elById = id => document.getElementById(id);

  const labsCount = elById('dashLabsCount');
  const labsSub   = elById('dashLabsSub');
  if (labsCount) labsCount.textContent = active.length;
  if (labsSub)   labsSub.textContent   = `${state.deployments.length} deployment${state.deployments.length !== 1 ? 's' : ''} total`;

  const vmsCount = elById('dashVmsCount');
  const vmsSub   = elById('dashVmsSub');
  const totalSeats = state.classrooms.reduce((s, c) => s + (c.workstationCount || 0), 0);
  if (vmsCount) vmsCount.textContent = totalVms;
  if (vmsSub)   vmsSub.textContent   = `across ${totalSeats} configured seats`;

  const bpCount = elById('dashBlueprintsCount');
  const bpSub   = elById('dashBlueprintsSub');
  if (bpCount) bpCount.textContent = state.blueprints.length;
  if (bpSub)   bpSub.textContent   = `${state.courses.length} course${state.courses.length !== 1 ? 's' : ''} configured`;

  const clCount = elById('dashClassroomsCount');
  const clSub   = elById('dashClassroomsSub');
  if (clCount) clCount.textContent = state.classrooms.length;
  if (clSub)   clSub.textContent   = state.classrooms.slice(0, 3).map(c => c.name).join(', ') + (state.classrooms.length > 3 ? '…' : '') || 'No classrooms';

  // Recent labs
  const labsList = elById('dashRecentLabsList');
  if (labsList) {
    if (!state.deployments.length) {
      labsList.innerHTML = '<p class="placeholder">No deployments yet.</p>';
    } else {
      labsList.innerHTML = state.deployments.slice(0, 5).map(d => {
        const badgeClass =
          ['running', 'deployed', 'mixed'].includes(d.status) ? 'dash-badge-running' :
          ['queued', 'deploying', 'customizing', 'starting'].includes(d.status) ? 'dash-badge-preparing' :
          d.status === 'stopped' ? 'dash-badge-stopped' : 'dash-badge-destroyed';
        const badgeText =
          ['running', 'deployed', 'mixed'].includes(d.status) ? 'Active' :
          ['queued', 'deploying', 'customizing', 'starting'].includes(d.status) ? 'Preparing' :
          d.status === 'stopped' ? 'Stopped' : escapeHtml(d.status || 'idle');
        return `
          <div class="dash-row">
            <div class="dash-row-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            </div>
            <div class="dash-row-info">
              <p class="dash-row-name">${escapeHtml(d.blueprint.name)} — ${escapeHtml(d.classroom.name)}</p>
              <p class="dash-row-meta">${d.totalVmCount} VMs · Lab #${d.deploymentNumber}</p>
            </div>
            <span class="dash-badge ${badgeClass}">${badgeText}</span>
          </div>`;
      }).join('');
    }
  }

  // VM Models list
  const modelsList = elById('dashModelsList');
  if (modelsList) {
    if (!state.templates.length) {
      modelsList.innerHTML = '<p class="placeholder">No VM models yet.</p>';
    } else {
      modelsList.innerHTML = state.templates.slice(0, 5).map(t => {
        const dotClass = getOsDotClass(t.osType);
        return `
          <div class="dash-row">
            <div class="dash-row-icon">
              <img src="${escapeHtmlAttr(getOsLogo(t.osType))}" alt="">
            </div>
            <div class="dash-row-info">
              <p class="dash-row-name">${escapeHtml(t.name)}</p>
              <p class="dash-row-meta">VMID ${t.proxmoxTemplateVmid} · ${getOsLabel(t.osType)}</p>
            </div>
            <span class="vm-lib-dot ${dotClass}"></span>
          </div>`;
      }).join('');
    }
  }

  // Active lifecycle tracker
  const lcCard  = elById('dashLifecycleCard');
  const lcTitle = elById('dashLifecycleTitle');
  const lcBadge = elById('dashLifecycleBadge');
  const lcSteps = elById('dashLifecycleSteps');
  const lcActs  = elById('dashLifecycleActions');

  const activeDeploy = state.deployments.find(d =>
    ['queued', 'deploying', 'customizing', 'deployed', 'starting', 'running', 'mixed', 'stopping'].includes(d.status)
  );

  if (lcCard) lcCard.hidden = !activeDeploy;

  if (activeDeploy) {
    if (lcTitle) lcTitle.textContent = `${activeDeploy.blueprint.name} · ${activeDeploy.classroom.name}`;
    if (lcBadge) {
      const ready = Number(activeDeploy.readyCount ?? 0);
      const total = Number(activeDeploy.totalVmCount ?? 0);
      lcBadge.textContent = `${ready}/${total} VMs`;
    }
    if (lcSteps) lcSteps.innerHTML = renderLifecycleSteps(activeDeploy.status);
    if (lcActs) {
      const acts = resolveLifecycleActions(activeDeploy.status);
      if (acts.busy) {
        lcActs.innerHTML = '<span class="loading-spinner"></span>';
      } else {
        lcActs.innerHTML = acts.items
          .map(a => `<button class="btn lifecycle-action" type="button" data-action="${a.action}" data-deployment-id="${activeDeploy.id}">${a.icon} ${a.label}</button>`)
          .join('');
        lcActs.querySelectorAll('.lifecycle-action').forEach(btn => {
          btn.addEventListener('click', async event => {
            event.stopPropagation();
            btn.disabled = true;
            try {
              const result = await fetchJson(`/api/lifecycle/deployments/${btn.dataset.deploymentId}/${btn.dataset.action}`, { method: 'POST' });
              await refreshLifecycleLabs();
              renderDashboard();
              showMessage(globalStatus, `${btn.dataset.action} queued with job ${result.jobId}.`, 'success');
            } catch (error) {
              showMessage(globalStatus, error.message, 'danger');
            } finally {
              btn.disabled = false;
            }
          });
        });
      }
    }
  }

  // Per-seat grid (derive from classroom + deployment)
  const seatCard  = elById('dashSeatCard');
  const seatTitle = elById('dashSeatTitle');
  const seatGrid  = elById('dashSeatGrid');

  if (seatCard) seatCard.hidden = !activeDeploy;

  if (activeDeploy && seatGrid) {
    const classroom = state.classrooms.find(c => c.id === activeDeploy.classroom.id);
    const seatCount = classroom?.workstationCount ?? Math.ceil(Number(activeDeploy.totalVmCount ?? 1) / 3);
    const shown = Math.min(seatCount, 12);
    const vmsPerSeat = seatCount > 0 ? Math.round(Number(activeDeploy.totalVmCount ?? 0) / seatCount) : 0;

    if (seatTitle) seatTitle.textContent = `${activeDeploy.blueprint.name} · ${seatCount} workstation${seatCount !== 1 ? 's' : ''}`;

    seatGrid.innerHTML = Array.from({ length: shown }, (_, i) => {
      const num = String(i + 1).padStart(2, '0');
      const tags = vmsPerSeat > 0
        ? `<span class="seat-tag seat-tag-vm">${vmsPerSeat} VM</span>`
        : '';
      return `<div class="seat-cell"><p class="seat-num">Poste ${num}</p><div class="seat-tags">${tags}</div></div>`;
    }).join('');
  }
}

function isDeploymentBusy(status) {
  return ['queued', 'deploying', 'customizing', 'starting', 'stopping', 'destroying'].includes(status);
}

function getDeploymentWorkstationNumber(vm) {
  const rawValue = String(vm?.workstationNumber ?? vm?.id ?? '').trim();
  const match = rawValue.match(/^(\d+)/);
  return match?.[1] ?? 'n/a';
}

function renderDeploymentVmRows(vms) {
  return vms
    .map(
      vm => `
        <tr>
          <td><span class="vm-state-dot" data-state="${escapeHtmlAttr(vm.state || 'unknown')}" title="${escapeHtmlAttr(vm.state || 'unknown')}"></span></td>
          <td class="vm-state-name-cell">
            <strong>${escapeHtml(vm.name)}</strong>
            <span class="muted">${vm.node ? escapeHtml(vm.node) : ''}</span>
          </td>
          <td>${vm.vmid}</td>
          <td>${escapeHtml(getOsLabel(vm.osType))}</td>
          <td>${escapeHtml(String(vm.vlanTag ?? 'n/a'))}</td>
          <td>${escapeHtml(vm.ipAddress || 'n/a')}</td>
          <td>${escapeHtml(vm.state || 'unknown')}</td>
          <td>${escapeHtml(vm.proxmoxStatus || 'n/a')}</td>
        </tr>
      `
    )
    .join('');
}

async function redeployDeploymentWorkstation(deploymentId, workstationNumber, button) {
  if (!deploymentDetailsStatus) return;
  button.disabled = true;
  try {
    await fetchJson(`/api/lifecycle/deployments/${deploymentId}/workstations/${workstationNumber}/redeploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    await Promise.all([refreshLifecycleLabs(), refreshOpenDeploymentDetails()]);
    showMessage(deploymentDetailsStatus, `Workplace ${workstationNumber} redeploy queued.`, 'success', 5000);
  } catch (error) {
    showMessage(deploymentDetailsStatus, error.message, 'danger', 5000);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
    }
  }
}

function renderDeploymentVmDetails(payload) {
  if (!deploymentVmDetailsList) return;
  const deployment = payload?.deployment ?? {};
  const vms = Array.isArray(payload?.vms) ? payload.vms : [];
  if (!vms.length) {
    deploymentVmDetailsList.innerHTML = '<p class="placeholder">No VMs found for this deployment.</p>';
    return;
  }

  const workstationGroups = new Map();
  for (const vm of vms) {
    const workstationNumber = getDeploymentWorkstationNumber(vm);
    if (!workstationGroups.has(workstationNumber)) {
      workstationGroups.set(workstationNumber, []);
    }
    workstationGroups.get(workstationNumber).push(vm);
  }
  const orderedWorkstations = [...workstationGroups.keys()].sort((left, right) => Number(left) - Number(right));
  const activeWorkstationNumbers = new Set(Array.isArray(deployment.activeWorkstationNumbers) ? deployment.activeWorkstationNumbers : []);
  const canRedeployWorkstations = Boolean(deployment.canRedeployWorkstations) && !isDeploymentBusy(deployment.status);

  deploymentVmDetailsList.innerHTML = `
    <div class="workstation-detail-list">
      ${orderedWorkstations
        .map(workstationNumber => {
          const workstationVms = workstationGroups.get(workstationNumber) ?? [];
          const isActiveWorkstation = activeWorkstationNumbers.has(workstationNumber);
          const actionMarkup = canRedeployWorkstations
            ? `<button class="btn btn-secondary workstation-redeploy-button" type="button" data-deployment-id="${escapeHtmlAttr(deployment.id || '')}" data-workstation-number="${escapeHtmlAttr(workstationNumber)}">Redeploy VMs</button>`
            : isActiveWorkstation
              ? '<button class="btn btn-secondary" type="button" disabled>Redeploying...</button>'
              : '';

          return `
            <section class="workstation-detail-card">
              <div class="panel-head workstation-detail-head">
                <div class="workstation-detail-summary">
                  <strong>Workplace ${escapeHtml(workstationNumber)}</strong>
                  <p class="muted">${workstationVms.length} VM</p>
                </div>
                ${actionMarkup}
              </div>
              <div class="table-wrap vm-state-table-wrap">
                <table class="queue-table vm-state-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>VM</th>
                      <th>VMID</th>
                      <th>OS</th>
                      <th>VLAN</th>
                      <th>IP</th>
                      <th>State</th>
                      <th>Proxmox</th>
                    </tr>
                  </thead>
                  <tbody>${renderDeploymentVmRows(workstationVms)}</tbody>
                </table>
              </div>
            </section>
          `;
        })
        .join('')}
    </div>
  `;

  deploymentVmDetailsList.querySelectorAll('.workstation-redeploy-button').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      await redeployDeploymentWorkstation(
        button.dataset.deploymentId,
        button.dataset.workstationNumber,
        button
      );
    });
  });
}

async function openDeploymentDetails(deploymentId) {
  if (!deploymentDetailsDialog || !deploymentVmDetailsList || !deploymentDetailsTitle || !deploymentDetailsStatus) return;
  state.activeDeploymentDetailsId = deploymentId;
  deploymentDetailsTitle.textContent = 'Deployment';
  deploymentVmDetailsList.innerHTML = '<p class="placeholder">Loading deployment VMs...</p>';
  deploymentDetailsStatus.hidden = true;
  if (!deploymentDetailsDialog.open) {
    deploymentDetailsDialog.showModal();
  }

  await refreshOpenDeploymentDetails({ replaceOnError: true });
}

async function refreshOpenDeploymentDetails({ replaceOnError = false } = {}) {
  const deploymentId = state.activeDeploymentDetailsId;
  if (!deploymentId || !deploymentDetailsDialog?.open || !deploymentVmDetailsList || !deploymentDetailsTitle || !deploymentDetailsStatus) {
    return;
  }

  try {
    const payload = await fetchJson(`/api/lifecycle/deployments/${deploymentId}/vms`);
    if (state.activeDeploymentDetailsId !== deploymentId || !deploymentDetailsDialog.open) return;
    deploymentDetailsTitle.textContent = `${payload.deployment.blueprintName} @ ${payload.deployment.classroomName}`;
    renderDeploymentVmDetails(payload);
    deploymentDetailsStatus.hidden = true;
  } catch (error) {
    if (replaceOnError) {
      deploymentVmDetailsList.innerHTML = '<p class="placeholder">Unable to load deployment VMs.</p>';
    }
    showMessage(deploymentDetailsStatus, error.message, 'danger', 5000);
  }
}

function resolveLifecycleActions(status) {
  if (isDeploymentBusy(status)) {
    return { busy: true, items: [] };
  }
  if (status === 'destroyed') {
    return {
      busy: false,
      items: [{ action: 'deploy', icon: '↑', label: 'Deploy lab' }]
    };
  }
  if (!status || status === 'idle') {
    return {
      busy: false,
      items: [{ action: 'deploy', icon: '⬆', label: 'Deploy lab' }]
    };
  }
  if (status === 'running') {
    return { busy: false, items: [{ action: 'stop', icon: '■', label: 'Stop lab' }] };
  }
  if (status === 'mixed') {
    return {
      busy: false,
      items: [
        { action: 'start', icon: '▶', label: 'Start lab' },
        { action: 'stop', icon: '■', label: 'Stop lab' }
      ]
    };
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
  return {
    busy: false,
    items: [
      { action: 'deploy', icon: '⬆', label: 'Deploy lab' },
      { action: 'destroy', icon: '✕', label: 'Destroy deployment' }
    ]
  };
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

  return promptVmIpLastOctet().then(ipLastOctet => {
    if (ipLastOctet == null) return;

    state.currentBlueprint.vms.push({
      id: crypto.randomUUID(),
      templateId,
      name: '',
      ipLastOctet,
      config: { customNameEnabled: false }
    });
    renderCanvas();
  });
}

function promptVmCustomization({ title, initialValue = '', onSubmit }) {
  if (!vmCustomizationDialog || !vmCustomizationForm || !vmCustomizationValueInput || !vmCustomizationTitle) {
    return Promise.resolve(false);
  }

  if (pendingVmCustomization?.resolve) {
    pendingVmCustomization.resolve(false);
  }

  vmCustomizationTitle.textContent = title;
  vmCustomizationValueInput.value = initialValue;

  return new Promise(resolve => {
    pendingVmCustomization = { resolve, onSubmit };
    vmCustomizationDialog.showModal();
    window.setTimeout(() => {
      vmCustomizationValueInput.focus();
      vmCustomizationValueInput.select();
    }, 0);
  });
}

async function promptVmName(vmId) {
  const vm = state.currentBlueprint.vms.find(item => item.id === vmId);
  if (!vm) return;
  const submitted = await promptVmCustomization({
    title: 'Set Hostname',
    initialValue: vm.name || '',
    onSubmit: value => {
      updateVm(vmId, nextVm => {
        nextVm.config.customNameEnabled = true;
        nextVm.name = value.trim();
      });
      renderCanvas();
    }
  });
  if (!submitted) {
    renderCanvas();
  }
}

async function promptVmTimezone(vmId) {
  const vm = state.currentBlueprint.vms.find(item => item.id === vmId);
  if (!vm || !vmTimezoneDialog || !vmTimezoneForm || !vmTimezoneValueSelect) return;
  const template = state.templates.find(item => item.id === vm.templateId);
  const isWindows = ['windows11', 'windows-server'].includes(String(template?.osType || ''));
  const timezoneOptions = isWindows
    ? (state.timezoneOptions.windows.length ? state.timezoneOptions.windows : FALLBACK_WINDOWS_TIMEZONE_OPTIONS)
    : (state.timezoneOptions.linux.length ? state.timezoneOptions.linux : FALLBACK_LINUX_TIMEZONE_OPTIONS);
  const defaultTimezone = isWindows ? DEFAULT_WINDOWS_TIMEZONE : DEFAULT_LINUX_TIMEZONE;

  if (pendingVmTimezonePrompt?.resolve) {
    pendingVmTimezonePrompt.resolve(false);
  }

  vmTimezoneValueSelect.innerHTML = timezoneOptions
    .map(option => `<option value="${escapeHtmlAttr(option.id)}">${escapeHtml(option.label)}</option>`)
    .join('');
  vmTimezoneValueSelect.value = String(vm.config?.timezone || defaultTimezone).trim() || defaultTimezone;

  const submitted = await new Promise(resolve => {
    pendingVmTimezonePrompt = { resolve, vmId };
    vmTimezoneDialog.showModal();
    window.setTimeout(() => {
      vmTimezoneValueSelect.focus();
    }, 0);
  });

  if (!submitted) {
    renderCanvas();
  }
}

async function loadTimezoneOptions() {
  try {
    const payload = await fetchJson('/api/timezones');
    state.timezoneOptions = {
      windows: Array.isArray(payload?.windows) && payload.windows.length ? payload.windows : FALLBACK_WINDOWS_TIMEZONE_OPTIONS,
      linux: Array.isArray(payload?.linux) && payload.linux.length ? payload.linux : FALLBACK_LINUX_TIMEZONE_OPTIONS
    };
  } catch {
    state.timezoneOptions = {
      windows: FALLBACK_WINDOWS_TIMEZONE_OPTIONS,
      linux: FALLBACK_LINUX_TIMEZONE_OPTIONS
    };
  }
}

function promptVmIpLastOctet({ initialValue = null, title = 'Set IP last octet', submitLabel = 'Add VM' } = {}) {
  if (!vmIpDialog || !vmIpForm || !vmIpValueInput) {
    return Promise.resolve(null);
  }

  if (pendingVmIpPrompt?.resolve) {
    pendingVmIpPrompt.resolve(null);
  }

  const dialogTitle = vmIpDialog.querySelector('h3');
  if (dialogTitle) {
    dialogTitle.textContent = title;
  }
  if (vmIpSubmitButton) {
    vmIpSubmitButton.textContent = submitLabel;
  }
  vmIpValueInput.value = initialValue == null ? '' : String(initialValue);
  if (vmIpHelp) {
    vmIpHelp.textContent = 'Enter the last IPv4 octet for this VM.';
  }

  return new Promise(resolve => {
    pendingVmIpPrompt = { resolve };
    vmIpDialog.showModal();
    window.setTimeout(() => {
      vmIpValueInput.focus();
      vmIpValueInput.select();
    }, 0);
  });
}

function parseIpLastOctet(value) {
  if (value === '' || value == null) return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 254) {
    return null;
  }
  return numeric;
}

function parseVlanMaskBits(mask) {
  const match = /^\/(\d{1,2})$/.exec(String(mask || '').trim());
  if (!match) return null;
  const bits = Number(match[1]);
  if (bits < 24 || bits > 30) return null;
  return bits;
}

function getSubnetSizeFromMask(mask) {
  const bits = parseVlanMaskBits(mask);
  if (bits == null) return null;
  return 2 ** (32 - bits);
}

function getSubnetBaseOctet(ipLastOctet, mask) {
  const subnetSize = getSubnetSizeFromMask(mask);
  if (subnetSize == null || ipLastOctet == null) return null;
  return Math.floor(ipLastOctet / subnetSize) * subnetSize;
}

function getGatewayOctet(ipLastOctet, mask, gatewayHostOffset) {
  const subnetSize = getSubnetSizeFromMask(mask);
  const subnetBase = getSubnetBaseOctet(ipLastOctet, mask);
  const offset = Number(gatewayHostOffset);
  if (subnetSize == null || subnetBase == null || !Number.isInteger(offset) || offset < 1 || offset >= subnetSize - 1) {
    return null;
  }
  return subnetBase + offset;
}

function isIpLastOctetCompatibleWithMask(ipLastOctet, mask, gatewayHostOffset = 1) {
  if (ipLastOctet == null) return true;
  const subnetSize = getSubnetSizeFromMask(mask);
  if (subnetSize == null) return true;
  const offsetInSubnet = ipLastOctet % subnetSize;
  if (offsetInSubnet === 0 || offsetInSubnet === subnetSize - 1) return false;
  const gatewayOctet = getGatewayOctet(ipLastOctet, mask, gatewayHostOffset);
  return gatewayOctet == null ? true : ipLastOctet !== gatewayOctet;
}

function getIpLastOctetMaskMessage(mask, gatewayHostOffset = 1) {
  return `IP last octet is not compatible with VLAN mask ${mask} and gateway offset ${gatewayHostOffset}.`;
}

function deriveGatewayFromSubnet(subnet) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?$/.exec(String(subnet || '').trim());
  if (!match) return '';
  const parts = match.slice(1, 4).map(Number);
  if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return '';
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

function renderTeacherIdentity(teacher) {
  const email = String(teacher?.email || '').trim();
  const initials = String(teacher?.initials || '').trim();
  const displayName = String(teacher?.displayName || '').trim() || email || 'Unknown teacher';

  if (initials) {
    return `
      <span class="teacher-chip" title="${escapeHtmlAttr(displayName)}">
        <span class="teacher-chip-badge">${escapeHtml(initials)}</span>
        <span>${escapeHtml(email || displayName)}</span>
      </span>
    `;
  }

  return `<span>${escapeHtml(displayName)}</span>`;
}

function renderTeacherBadge(teacher) {
  const email = String(teacher?.email || '').trim();
  const initials = String(teacher?.initials || '').trim();
  const displayName = String(teacher?.displayName || '').trim() || email || 'Unknown teacher';
  const label = initials || displayName;

  return `<span class="mini-pill teacher-pill" title="${escapeHtmlAttr(displayName)}">${escapeHtml(label)}</span>`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && payload.loginUrl) {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.assign(`${payload.loginUrl}?returnTo=${encodeURIComponent(returnTo)}`);
      throw new Error('Authentication required');
    }
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
  renderDashboard();
}

function populateTemplateForm(template) {
  templateForm.elements.name.value = template.name || '';
  templateForm.elements.description.value = template.description || '';
  templateForm.elements.proxmoxTemplateVmid.value = String(template.proxmoxTemplateVmid || '');
  templateForm.elements.language.value = template.language || 'en';
  templateForm.elements.fullClone.checked = Boolean(template.fullClone);
  const osRadio = templateForm.querySelector(`input[name="osType"][value="${template.osType}"]`);
  if (osRadio) {
    osRadio.checked = true;
  }
  state.editingTemplateId = template.id;
  state.isTemplateEditorVisible = true;
  if (templateSubmitButton) {
    templateSubmitButton.textContent = 'Save changes';
  }
  if (cancelTemplateEditButton) {
    cancelTemplateEditButton.hidden = false;
  }
  renderTemplateEditor();
  renderModelList();
}

function resetTemplateForm({ keepVisible = false } = {}) {
  state.editingTemplateId = null;
  state.isTemplateEditorVisible = keepVisible;
  templateForm.reset();
  if (templateSubmitButton) {
    templateSubmitButton.textContent = 'Add model';
  }
  if (cancelTemplateEditButton) {
    cancelTemplateEditButton.hidden = true;
  }
  renderTemplateEditor();
  renderModelList();
}

function populateClassroomForm(classroom) {
  if (!classroomForm) return;
  classroomForm.elements.name.value = classroom.name || '';
  classroomForm.elements.workstationCount.value = String(classroom.workstationCount || '');
  classroomForm.elements.startingVlan.value = String(classroom.startingVlan || '');
  classroomForm.elements.startingSubnet.value = classroom.startingSubnet || '';
  classroomForm.elements.networkGateway.value = classroom.networkGateway || '';
  classroomForm.elements.networkVlanMask.value = classroom.networkVlanMask || '/24';
  if (classroomNetworkGatewayInput) {
    classroomNetworkGatewayInput.dataset.autoDerived = 'false';
  }
  state.editingClassroomId = classroom.id;
  state.isClassroomEditorVisible = true;
  if (classroomSubmitButton) {
    classroomSubmitButton.textContent = 'Save changes';
  }
  if (cancelClassroomEditButton) {
    cancelClassroomEditButton.hidden = false;
  }
  renderClassroomEditor();
  renderClassrooms();
}

function resetClassroomForm({ keepVisible = false } = {}) {
  state.editingClassroomId = null;
  state.isClassroomEditorVisible = keepVisible;
  classroomForm?.reset();
  if (classroomNetworkGatewayInput) {
    classroomNetworkGatewayInput.value = deriveGatewayFromSubnet(
      classroomStartingSubnetInput?.value || classroomStartingSubnetInput?.getAttribute('placeholder') || ''
    );
    classroomNetworkGatewayInput.dataset.autoDerived = 'true';
  }
  if (classroomSubmitButton) {
    classroomSubmitButton.textContent = 'Add classroom';
  }
  if (cancelClassroomEditButton) {
    cancelClassroomEditButton.hidden = true;
  }
  renderClassroomEditor();
  renderClassrooms();
}

async function loadAppInfo() {
  const info = await fetchJson('/api/app-info');
  state.auth = info.auth || { enabled: false };
  state.currentUser = info.auth?.user || null;

  if (appVersion) {
    appVersion.textContent = `Version ${info.version ?? '--'}`;
  }

  if (!userSession || !userSessionName || !userSessionMeta) {
    return;
  }

  if (!state.auth.enabled || !state.currentUser) {
    userSession.hidden = true;
    return;
  }

  userSessionName.textContent = state.currentUser.name || state.currentUser.username || 'Authenticated user';
  userSessionMeta.textContent = state.currentUser.email || state.currentUser.username || '';
  if (logoutLink && state.auth.logoutUrl) {
    logoutLink.href = state.auth.logoutUrl;
  }
  userSession.hidden = false;
}

function applyHealthIndicator(indicator, labelNode, label, status, title) {
  if (!indicator || !labelNode) return;
  indicator.dataset.state = status;
  labelNode.textContent = label;
  indicator.title = title || label;
}

async function loadConnectionStatuses() {
  if (!proxmoxStatusIndicator || !proxmoxStatusLabel) return;

  try {
    const payload = await fetchJson('/api/health');
    applyHealthIndicator(
      postgresStatusIndicator,
      postgresStatusLabel,
      'Postgres',
      payload?.postgres?.ok ? 'ok' : 'error',
      payload?.postgres?.ok ? 'Connected to PostgreSQL' : String(payload?.postgres?.error || 'Unable to connect to PostgreSQL')
    );
    applyHealthIndicator(
      proxmoxStatusIndicator,
      proxmoxStatusLabel,
      'Proxmox',
      payload?.proxmox?.ok ? 'ok' : 'error',
      payload?.proxmox?.ok ? 'Connected to Proxmox' : String(payload?.proxmox?.error || 'Unable to connect to Proxmox')
    );

    const terraformWorkerStatus = payload?.workers?.terraform ?? 'unknown';
    const ansibleWorkerStatus = payload?.workers?.ansible ?? 'unknown';
    applyHealthIndicator(
      terraformWorkerStatusIndicator,
      terraformWorkerStatusLabel,
      'Terraform Worker',
      terraformWorkerStatus === 'running' ? 'ok' : terraformWorkerStatus === 'paused' ? 'warning' : 'error',
      `Terraform worker: ${terraformWorkerStatus}`
    );
    applyHealthIndicator(
      ansibleWorkerStatusIndicator,
      ansibleWorkerStatusLabel,
      'Ansible Worker',
      ansibleWorkerStatus === 'running' ? 'ok' : ansibleWorkerStatus === 'paused' ? 'warning' : 'error',
      `Ansible worker: ${ansibleWorkerStatus}`
    );
  } catch (error) {
    const message = error.message || 'Unable to load connection statuses';
    applyHealthIndicator(postgresStatusIndicator, postgresStatusLabel, 'Postgres', 'error', message);
    applyHealthIndicator(proxmoxStatusIndicator, proxmoxStatusLabel, 'Proxmox', 'error', message);
    applyHealthIndicator(terraformWorkerStatusIndicator, terraformWorkerStatusLabel, 'Terraform Worker', 'error', message);
    applyHealthIndicator(ansibleWorkerStatusIndicator, ansibleWorkerStatusLabel, 'Ansible Worker', 'error', message);
  }
}

async function loadClassrooms() {
  state.classrooms = await fetchJson('/api/classrooms');
  renderClassrooms();
  renderDashboard();
}

async function loadBlueprints() {
  state.blueprints = await fetchJson('/api/blueprints');
  renderBlueprintList();
  renderDeploymentSelectors();
  renderDashboard();
}

async function loadTeachers() {
  state.teachers = await fetchJson('/api/teachers');
  renderTeachers();
}

async function loadCourses() {
  state.courses = await fetchJson('/api/courses');
  renderCourses();
  renderBlueprintCourseOptions();
}

async function refreshLifecycleLabs() {
  const previousDeploymentsById = new Map(state.deployments.map(deployment => [deployment.id, deployment]));
  const nextDeployments = await fetchJson('/api/lifecycle/deployments');
  state.deployments = nextDeployments.map(deployment => {
    const previous = previousDeploymentsById.get(deployment.id);
    const sameTransientPhase = previous
      && previous.status === deployment.status
      && ['queued', 'deploying', 'customizing'].includes(deployment.status);

    if (!sameTransientPhase) {
      return deployment;
    }

    return {
      ...deployment,
      createdCount: Math.max(Number(previous.createdCount ?? 0), Number(deployment.createdCount ?? 0)),
      startedCount: Math.max(Number(previous.startedCount ?? 0), Number(deployment.startedCount ?? 0)),
      readyCount: Math.max(Number(previous.readyCount ?? 0), Number(deployment.readyCount ?? 0)),
      customizedCount: Math.max(Number(previous.customizedCount ?? 0), Number(deployment.customizedCount ?? 0))
    };
  });
  renderLifecycleLabs();
  renderDashboard();
}

async function loadBlueprint(blueprintId) {
  const blueprint = await fetchJson(`/api/blueprints/${blueprintId}`);
  state.currentBlueprint = {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description || '',
    status: blueprint.status,
    courseId: blueprint.course?.id || '',
    windowsAdminPassword: blueprint.windowsAdminPassword || '',
    linuxDefaultUsername: blueprint.linuxDefaultUsername || 'ubuntu',
    vms: blueprint.vms.map(vm => ({
      id: vm.id,
      templateId: vm.template.id,
      name: vm.name,
      ipLastOctet: vm.ipLastOctet ?? null,
      config: { customNameEnabled: true, ...(vm.config || {}) }
    }))
  };
  state.isBlueprintWorkspaceVisible = true;
  syncBlueprintFields();
  renderBlueprintWorkspace();
  renderCanvas();
  renderBlueprintList();
  showMessage(globalStatus, 'Blueprint loaded.', 'success');
}

function resetBlueprintEditor({ keepVisible = false } = {}) {
  state.currentBlueprint = createEmptyBlueprint();
  state.isBlueprintWorkspaceVisible = keepVisible;
  syncBlueprintFields();
  renderBlueprintWorkspace();
  renderCanvas();
  renderBlueprintList();
}

async function saveBlueprint() {
  state.currentBlueprint.name = blueprintNameInput.value.trim();
  state.currentBlueprint.description = blueprintDescriptionInput.value.trim();
  state.currentBlueprint.courseId = blueprintCourseIdInput?.value || '';
  state.currentBlueprint.windowsAdminPassword = blueprintWindowsAdminPasswordInput?.value ?? '';
  state.currentBlueprint.linuxDefaultUsername = blueprintLinuxDefaultUsernameInput?.value?.trim() || 'ubuntu';
  state.currentBlueprint.status = 'draft';

  if (!state.currentBlueprint.name) {
    throw new Error('Blueprint name is required');
  }
  if (!state.currentBlueprint.vms.length) {
    throw new Error('A lab must contain at least one VM');
  }
  if (!state.currentBlueprint.courseId) {
    throw new Error('A course must be selected');
  }

  const payload = {
    name: state.currentBlueprint.name,
    description: state.currentBlueprint.description,
    status: state.currentBlueprint.status,
    courseId: state.currentBlueprint.courseId,
    windowsAdminPassword: state.currentBlueprint.windowsAdminPassword,
    linuxDefaultUsername: state.currentBlueprint.linuxDefaultUsername,
    vms: state.currentBlueprint.vms.map(vm => ({
      id: state.currentBlueprint.id ? vm.id : undefined,
      templateId: vm.templateId || vm.template?.id,
      name: vm.name.trim(),
      ipLastOctet: vm.ipLastOctet,
      config: sanitizeConfig(vm.config)
    }))
  };

  payload.vms.forEach(vm => {
    if (vm.config.customNameEnabled && !vm.name) {
      throw new Error('Each VM with custom naming enabled must have a name');
    }
    if (vm.ipLastOctet != null && (vm.ipLastOctet < 1 || vm.ipLastOctet > 254)) {
      throw new Error('IP last octet must be between 1 and 254');
    }
  });

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
    windowsAdminPassword: blueprint.windowsAdminPassword || '',
    linuxDefaultUsername: blueprint.linuxDefaultUsername || 'ubuntu',
    vms: blueprint.vms.map(vm => ({
      id: vm.id,
      templateId: vm.template.id,
      name: vm.name,
      ipLastOctet: vm.ipLastOctet ?? null,
      config: { customNameEnabled: true, ...(vm.config || {}) }
    }))
  };

  syncBlueprintFields();
  renderCanvas();
  await loadBlueprints();
  try {
    await refreshLifecycleLabs();
  } catch (error) {
    console.error('Unable to refresh lifecycle labs after saving blueprint', error);
  }
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

function getOsLabel(osType) {
  if (osType === 'windows11') return 'Windows 11';
  if (osType === 'windows-server') return 'Windows Server';
  if (osType === 'other') return 'Other';
  return 'Ubuntu';
}

function getLanguageLabel(language) {
  return String(language || 'en').trim().toUpperCase() === 'FR' ? 'FR' : 'EN';
}

function getOsLogo(osType) {
  if (osType === 'windows11') return '/assets/os-windows11.png';
  if (osType === 'windows-server') return '/assets/os-windows-server.png';
  if (osType === 'other') return '/assets/os-other.svg';
  return '/assets/os-ubuntu.png';
}

function getCustomizationIcon(key) {
  if (key === 'name') {
    return `
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M5 18 9.5 6h1.8L16 18h-1.9l-1.1-3.1H8L6.9 18H5Zm3.6-4.7h3.8L10.5 8 8.6 13.3Z"></path>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M12 7a1 1 0 0 1 1 1v.4a4.6 4.6 0 0 1 2.6 2.6H16a1 1 0 1 1 0 2h-.4a4.6 4.6 0 0 1-2.6 2.6V16a1 1 0 1 1-2 0v-.4a4.6 4.6 0 0 1-2.6-2.6H8a1 1 0 1 1 0-2h.4A4.6 4.6 0 0 1 11 8.4V8a1 1 0 0 1 1-1Zm0 3.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6ZM19 4a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V6h-1a1 1 0 1 1 0-2h2Zm-14 0a1 1 0 1 1 0 2H4v1a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1h2Zm14 14a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1h-2a1 1 0 1 1 0-2h1v-1ZM4 18a1 1 0 1 1-2 0v2a1 1 0 0 0 1 1h2a1 1 0 1 0 0-2H4v-1Z"></path>
    </svg>
  `;
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
  if (!terraformSettingsForm) return;
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
  if (!terraformSettingsForm) return {};
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
  if (!terraformSettingsForm || !terraformSettingsStatus) return;
  try {
    const settings = await fetchJson('/api/settings/terraform');
    state.terraformSettings = settings;
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

function formatDuration(durationMs) {
  if (durationMs == null) return 'n/a';
  if (durationMs < 1000) return `${durationMs} ms`;
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatJobDetail(job) {
  if (job.failedReason) return job.failedReason;
  if (job.runId) return job.runId;
  return '-';
}

function formatAssociatedLab(job) {
  const label = String(job.associatedLab ?? 'n/a');
  if (job.deploymentNumber == null) {
    return label;
  }
  return `#${job.deploymentNumber} ${label}`;
}

async function refreshJobs() {
  if (!jobsTableBody) return;
  try {
    const jobs = await fetchJson('/api/jobs');
    if (!jobs.length) {
      jobsTableBody.innerHTML = '<tr><td colspan="8">No jobs yet.</td></tr>';
      return;
    }

    jobsTableBody.innerHTML = jobs
      .map(
        job => `
          <tr>
            <td>#${escapeHtml(job.id)}</td>
            <td>${escapeHtml(job.queue)}</td>
            <td>${escapeHtml(job.state ?? 'unknown')}</td>
            <td>${escapeHtml(formatAssociatedLab(job))}</td>
            <td>${escapeHtml(job.action ?? job.name ?? 'n/a')}</td>
            <td>${escapeHtml(formatDuration(job.durationMs))}</td>
            <td>${escapeHtml(job.createdAt ? new Date(job.createdAt).toLocaleString() : 'n/a')}</td>
            <td title="${escapeHtmlAttr(formatJobDetail(job))}">${escapeHtml(formatJobDetail(job))}</td>
          </tr>
        `
      )
      .join('');
  } catch {
    jobsTableBody.innerHTML = '<tr><td colspan="8">Unable to load jobs.</td></tr>';
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

document.getElementById('dashGotoLifecycle')?.addEventListener('click', () => setActiveView('lifecycle'));
document.getElementById('dashGotoModels')?.addEventListener('click', () => setActiveView('models'));

[blueprintNameInput, blueprintDescriptionInput, blueprintCourseIdInput, blueprintWindowsAdminPasswordInput, blueprintLinuxDefaultUsernameInput].forEach(input => {
  input.addEventListener('input', () => {
    state.currentBlueprint.name = blueprintNameInput.value;
    state.currentBlueprint.description = blueprintDescriptionInput.value;
    state.currentBlueprint.courseId = blueprintCourseIdInput?.value || '';
    state.currentBlueprint.windowsAdminPassword = blueprintWindowsAdminPasswordInput?.value ?? '';
    state.currentBlueprint.linuxDefaultUsername = blueprintLinuxDefaultUsernameInput?.value?.trim() || 'ubuntu';
    state.currentBlueprint.status = 'draft';
    syncBlueprintFields();
    renderBlueprintList();
  });
});

templateForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(templateForm);
  const editingTemplateId = state.editingTemplateId;
  const payload = {
    name: String(form.get('name') || '').trim(),
    description: String(form.get('description') || '').trim(),
    osType: String(form.get('osType') || 'ubuntu'),
    language: String(form.get('language') || 'en').trim().toLowerCase(),
    proxmoxTemplateVmid: Number(form.get('proxmoxTemplateVmid') || 0),
    fullClone: form.get('fullClone') === 'on'
  };

  try {
    await fetchJson(editingTemplateId ? `/api/templates/${editingTemplateId}` : '/api/templates', {
      method: editingTemplateId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    resetTemplateForm();
    await loadTemplates();
    showMessage(globalStatus, editingTemplateId ? 'VM model updated.' : 'VM model created.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  }
});

cancelTemplateEditButton?.addEventListener('click', () => {
  resetTemplateForm();
});

newTemplateButton?.addEventListener('click', () => {
  resetTemplateForm({ keepVisible: true });
});

newClassroomButton?.addEventListener('click', () => {
  resetClassroomForm({ keepVisible: true });
});

classroomStartingSubnetInput?.addEventListener('input', () => {
  if (!classroomNetworkGatewayInput) return;
  if (classroomNetworkGatewayInput.dataset.autoDerived !== 'false') {
    classroomNetworkGatewayInput.value = deriveGatewayFromSubnet(classroomStartingSubnetInput.value);
    classroomNetworkGatewayInput.dataset.autoDerived = 'true';
  }
});

classroomNetworkGatewayInput?.addEventListener('input', () => {
  classroomNetworkGatewayInput.dataset.autoDerived = 'false';
});

cancelClassroomEditButton?.addEventListener('click', () => {
  resetClassroomForm({ keepVisible: true });
});

classroomForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(classroomForm);
  const editingClassroomId = state.editingClassroomId;
  const payload = {
    name: String(form.get('name') || '').trim(),
    workstationCount: Number(form.get('workstationCount') || 0),
    startingVlan: Number(form.get('startingVlan') || 0),
    startingSubnet: String(form.get('startingSubnet') || '').trim(),
    networkGateway: String(form.get('networkGateway') || '').trim(),
    networkVlanMask: String(form.get('networkVlanMask') || '/24'),
    incrementVlan: true
  };

  try {
    await fetchJson(editingClassroomId ? `/api/classrooms/${editingClassroomId}` : '/api/classrooms', {
      method: editingClassroomId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    resetClassroomForm();
    await loadClassrooms();
    showMessage(globalStatus, editingClassroomId ? 'Classroom updated.' : 'Classroom created.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  }
});

courseForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(courseForm);
  const payload = {
    courseNumber: Number(form.get('courseNumber') || 0),
    description: String(form.get('description') || '').trim()
  };

  if (courseSubmitButton) {
    courseSubmitButton.disabled = true;
  }

  try {
    await fetchJson('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    courseForm.reset();
    await loadCourses();
    showMessage(globalStatus, 'Course created.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  } finally {
    if (courseSubmitButton) {
      courseSubmitButton.disabled = false;
    }
  }
});

deploymentForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(deploymentForm);
  const payload = {
    blueprintId: String(form.get('blueprintId') || ''),
    classroomId: String(form.get('classroomId') || '')
  };

  try {
    await fetchJson('/api/lifecycle/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await loadTeachers();
    await refreshLifecycleLabs();
    showMessage(globalStatus, 'Deployment prepared.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  }
});

newBlueprintButton.addEventListener('click', () => {
  resetBlueprintEditor({ keepVisible: true });
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
  dropzone.classList.toggle('dragover', getDragItemType(event.dataTransfer) === 'template');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const itemType = getDragItemType(event.dataTransfer);
  if (itemType !== 'template') {
    return;
  }
  const templateId =
    activeDragItem?.type === 'template'
      ? activeDragItem.value
      : event.dataTransfer.getData('text/plain');
  activeDragItem = null;
  addVmFromTemplate(templateId);
});

terraformSettingsForm?.addEventListener('submit', async event => {
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

refreshLabsStateButton?.addEventListener('click', async () => {
  refreshLabsStateButton.disabled = true;
  try {
    await fetchJson('/api/lifecycle/deployments/refresh-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    await refreshLifecycleLabs();
    showMessage(globalStatus, 'Labs state refreshed.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  } finally {
    refreshLabsStateButton.disabled = false;
  }
});

clearJobHistoryButton?.addEventListener('click', async () => {
  clearJobHistoryButton.disabled = true;
  try {
    await fetchJson('/api/jobs/clear-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    await Promise.all([refreshQueues(), refreshJobs()]);
    showMessage(globalStatus, 'Jobs in progress stopped and job history cleared.', 'success');
  } catch (error) {
    showMessage(globalStatus, error.message, 'danger');
  } finally {
    clearJobHistoryButton.disabled = false;
  }
});

cleanOrphanedDisksButton?.addEventListener('click', async () => {
  const targetStatus = dangerZoneStatus || globalStatus;
  const confirmed = window.confirm(
    'Clean orphaned disks from the configured Ceph pool? This deletes RBD images that are not referenced by VM configs.'
  );
  if (!confirmed) return;

  cleanOrphanedDisksButton.disabled = true;
  showMessage(targetStatus, 'Cleaning orphaned disks...', 'success', 120000);
  try {
    const result = await fetchJson('/api/settings/clean-orphaned-disks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const deletedCount = Array.isArray(result.deletedVolumes) ? result.deletedVolumes.length : 0;
    const skippedCount = Array.isArray(result.skippedVolumes) ? result.skippedVolumes.length : 0;
    showMessage(
      targetStatus,
      deletedCount === 0 && skippedCount === 0
        ? 'No orphaned disks found.'
        : `Deleted ${deletedCount} orphaned disk${deletedCount === 1 ? '' : 's'}; ignored ${skippedCount}.`,
      'success',
      8000
    );
  } catch (error) {
    showMessage(targetStatus, error.message, 'danger', 10000);
  } finally {
    cleanOrphanedDisksButton.disabled = false;
  }
});

closeDeploymentDetailsButton?.addEventListener('click', () => {
  deploymentDetailsDialog?.close();
});

deploymentDetailsDialog?.addEventListener('close', () => {
  state.activeDeploymentDetailsId = null;
});

deploymentDetailsDialog?.addEventListener('click', event => {
  const rect = deploymentDetailsDialog.getBoundingClientRect();
  const isOutside =
    event.clientX < rect.left
    || event.clientX > rect.right
    || event.clientY < rect.top
    || event.clientY > rect.bottom;
  if (isOutside) {
    deploymentDetailsDialog.close();
  }
});

vmCustomizationForm?.addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingVmCustomization) return;
  const value = String(vmCustomizationValueInput?.value ?? '').trim();
  if (!value) {
    vmCustomizationValueInput?.focus();
    return;
  }
  pendingVmCustomization.onSubmit(value);
  pendingVmCustomization.resolve(true);
  pendingVmCustomization = null;
  vmCustomizationDialog?.close();
});

vmCustomizationCancelButton?.addEventListener('click', () => {
  if (pendingVmCustomization?.resolve) {
    pendingVmCustomization.resolve(false);
  }
  pendingVmCustomization = null;
  vmCustomizationDialog?.close();
});

vmCustomizationDialog?.addEventListener('close', () => {
  if (pendingVmCustomization?.resolve) {
    pendingVmCustomization.resolve(false);
  }
  pendingVmCustomization = null;
});

vmIpForm?.addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingVmIpPrompt || !vmIpValueInput) return;

  const ipLastOctet = parseIpLastOctet(vmIpValueInput.value);

  if (ipLastOctet == null) {
    if (vmIpHelp) {
      vmIpHelp.textContent = 'Enter a number between 1 and 254.';
    }
    vmIpValueInput.focus();
    return;
  }

  pendingVmIpPrompt.resolve(ipLastOctet);
  pendingVmIpPrompt = null;
  vmIpDialog?.close();
});

vmIpCancelButton?.addEventListener('click', () => {
  if (pendingVmIpPrompt?.resolve) {
    pendingVmIpPrompt.resolve(null);
  }
  pendingVmIpPrompt = null;
  vmIpDialog?.close();
});

vmIpDialog?.addEventListener('close', () => {
  if (pendingVmIpPrompt?.resolve) {
    pendingVmIpPrompt.resolve(null);
  }
  pendingVmIpPrompt = null;
});

vmTimezoneForm?.addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingVmTimezonePrompt || !vmTimezoneValueSelect) return;

  const vm = state.currentBlueprint.vms.find(item => item.id === pendingVmTimezonePrompt.vmId);
  const template = state.templates.find(item => item.id === vm?.templateId);
  const fallbackTimezone = ['windows11', 'windows-server'].includes(String(template?.osType || ''))
    ? DEFAULT_WINDOWS_TIMEZONE
    : DEFAULT_LINUX_TIMEZONE;
  const timezone = String(vmTimezoneValueSelect.value || fallbackTimezone).trim() || fallbackTimezone;
  updateVm(pendingVmTimezonePrompt.vmId, vm => {
    vm.config.timezone = timezone;
  });
  renderCanvas();
  pendingVmTimezonePrompt.resolve(true);
  pendingVmTimezonePrompt = null;
  vmTimezoneDialog?.close();
});

vmTimezoneCancelButton?.addEventListener('click', () => {
  if (pendingVmTimezonePrompt?.resolve) {
    pendingVmTimezonePrompt.resolve(false);
  }
  pendingVmTimezonePrompt = null;
  vmTimezoneDialog?.close();
});

vmTimezoneDialog?.addEventListener('close', () => {
  if (pendingVmTimezonePrompt?.resolve) {
    pendingVmTimezonePrompt.resolve(false);
  }
  pendingVmTimezonePrompt = null;
});

async function bootstrap() {
  setActiveView('dashboard');
  syncBlueprintFields();
  renderBlueprintWorkspace();
  renderTemplateEditor();
  renderClassroomEditor();
  renderCanvas();
  await Promise.all([
    loadAppInfo(),
    loadConnectionStatuses(),
    loadTeachers(),
    loadCourses(),
    loadClassrooms(),
    loadTemplates(),
    loadBlueprints(),
    loadTimezoneOptions(),
    refreshLifecycleLabs(),
    loadTerraformSettings(),
    refreshQueues(),
    refreshJobs(),
    refreshWorkers()
  ]);
  setInterval(() => {
    refreshQueues();
    refreshJobs();
    refreshWorkers();
    refreshLifecycleLabs();
    refreshOpenDeploymentDetails();
  }, 5000);
  setInterval(() => {
    loadConnectionStatuses();
  }, 30000);
}

bootstrap().catch(error => {
  showMessage(globalStatus, error.message || 'Unable to initialise dashboard', 'danger', 5000);
});

