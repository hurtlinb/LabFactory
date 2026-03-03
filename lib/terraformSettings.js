const terraformSettingDefinitions = {
  proxmox_api_url: 'string',
  proxmox_api_token_id: 'string',
  proxmox_api_token_secret: 'string',
  proxmox_tls_insecure: 'boolean',
  proxmox_node: 'string',
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
  network_bridge: 'string',
  network_model: 'string',
  network_firewall: 'boolean',
  network_vlan_tag: 'number'
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

export const defaultTerraformSettings = {
  proxmox_api_url: 'https://pve.example.com:8006/api2/json',
  proxmox_api_token_id: '',
  proxmox_api_token_secret: '',
  proxmox_tls_insecure: true,
  proxmox_node: 'pve01',
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
  network_bridge: 'vmbr0',
  network_model: 'virtio',
  network_firewall: false,
  network_vlan_tag: 0
};
