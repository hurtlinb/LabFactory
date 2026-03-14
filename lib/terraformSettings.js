const terraformSettingDefinitions = {
  vm_id: 'number',
  vm_name: 'string',
  vm_template_name: 'string',
  vm_pool: 'string',
  vm_cores: 'number',
  vm_sockets: 'number',
  vm_memory: 'number',
  vm_onboot: 'boolean',
  vm_description: 'string',
  vm_scsi_hw: 'string',
  vm_full_clone: 'boolean',
  windows_admin_password: 'string',
  network_bridge: 'string',
  network_vlan_gateway_host_offset: 'number',
  network_model: 'string',
  network_firewall: 'boolean',
  network_vlan_tag: 'number',
  network_vlan_mask: 'string'
};

const terraformEnvMapping = {
  proxmox_api_url: 'PROXMOX_API_URL',
  proxmox_node: 'PROXMOX_NODE',
  proxmox_tls_insecure: 'PROXMOX_TLS_INSECURE',
  proxmox_api_token_id: 'PROXMOX_API_TOKEN_ID',
  proxmox_api_token_secret: 'PROXMOX_API_TOKEN_SECRET'
};

const requiredTerraformEnvKeys = Object.keys(terraformEnvMapping);
const terraformEnvValueTypes = {
  proxmox_tls_insecure: 'boolean'
};

const parseSettingValue = (key, value) => {
  const type = terraformSettingDefinitions[key];
  if (value === null || value === undefined) {
    throw new Error(`Missing value for ${key}`);
  }

  if (type === 'number') {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid number for ${key}`);
    }
    return parsed;
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return Boolean(value);
  }

  return typeof value === 'string' ? value.trim() : String(value);
};

export const sanitizeSettingsInput = input => {
  const result = {};

  for (const key of Object.keys(terraformSettingDefinitions)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = parseSettingValue(key, input[key]);
    }
  }

  return result;
};

export const readTerraformEnvSettings = () => {
  const result = {};

  for (const [settingKey, envVarName] of Object.entries(terraformEnvMapping)) {
    const rawValue = process.env[envVarName];
    if (rawValue === undefined) continue;
    const normalized = String(rawValue).trim();
    if (terraformEnvValueTypes[settingKey] === 'boolean') {
      result[settingKey] = normalized.toLowerCase() === 'true';
    } else {
      result[settingKey] = normalized;
    }
  }

  return result;
};

export const assertRequiredTerraformEnvSettings = settings => {
  const missing = requiredTerraformEnvKeys.filter(key => !settings[key]);
  if (missing.length) {
    const missingEnvVars = missing.map(key => terraformEnvMapping[key]);
    throw new Error(
      `Missing required environment variables for Terraform settings: ${missingEnvVars.join(', ')}`
    );
  }
};

export const defaultTerraformSettings = {
  vm_id: 150,
  vm_name: 'labfactory-empty-vm',
  vm_template_name: 'labfactory-template',
  vm_pool: '',
  vm_cores: 2,
  vm_sockets: 1,
  vm_memory: 2048,
  vm_onboot: false,
  vm_description: 'Empty VM created by the LabFactory Terraform playbook.',
  vm_scsi_hw: 'virtio-scsi-pci',
  vm_full_clone: true,
  windows_admin_password: '',
  network_bridge: 'vmbr0',
  network_vlan_gateway_host_offset: 1,
  network_model: 'virtio',
  network_firewall: false,
  network_vlan_tag: 0,
  network_vlan_mask: '/24'
};
