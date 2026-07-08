export const DEFAULT_VM_POOL_NAME = 'pool';
export const VM_POOL_TAG = 'labfactory-pool';

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export const parseVlanMaskBits = value => {
  const normalized = String(value ?? '').trim();
  const match = normalized.match(/^\/?(\d{1,2})$/);
  if (!match) return null;
  const bits = Number(match[1]);
  return bits >= 1 && bits <= 32 ? bits : null;
};

export const getVmPoolConfig = () => {
  const ipPrefix = String(process.env.VM_POOL_IP_PREFIX ?? '').trim();
  const networkMask = String(process.env.VM_POOL_NETWORK_MASK ?? '/24').trim() || '/24';
  return {
    poolName: String(process.env.VM_POOL_PROXMOX_POOL ?? DEFAULT_VM_POOL_NAME).trim() || DEFAULT_VM_POOL_NAME,
    runIntervalMs: parsePositiveInteger(process.env.VM_POOL_MANAGER_INTERVAL_MS, 5 * 60 * 1000),
    batchSize: Math.min(parsePositiveInteger(process.env.VM_POOL_MANAGER_BATCH_SIZE, 5), 50),
    vmidStart: parsePositiveInteger(process.env.VM_POOL_VMID_START, 70000),
    vmidEnd: parsePositiveInteger(process.env.VM_POOL_VMID_END, 79999),
    ipPrefix,
    ipStart: parsePositiveInteger(process.env.VM_POOL_IP_START, 10),
    ipEnd: parsePositiveInteger(process.env.VM_POOL_IP_END, 250),
    networkMask,
    gateway: String(process.env.VM_POOL_GATEWAY ?? '').trim(),
    vlanTag: parseNonNegativeInteger(process.env.VM_POOL_VLAN_TAG, 0),
    dnsServers: String(process.env.VM_POOL_DNS_SERVERS ?? '195.186.4.162,195.186.4.163')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    windowsAdminPassword: String(process.env.VM_POOL_WINDOWS_ADMIN_PASSWORD ?? '').trim()
  };
};

export const assertVmPoolProvisioningConfig = config => {
  const missing = [];
  if (!config.ipPrefix) missing.push('VM_POOL_IP_PREFIX');
  if (!config.gateway) missing.push('VM_POOL_GATEWAY');
  if (!config.windowsAdminPassword) missing.push('VM_POOL_WINDOWS_ADMIN_PASSWORD');
  if (config.vmidEnd < config.vmidStart) missing.push('VM_POOL_VMID_END');
  if (config.ipEnd < config.ipStart || config.ipStart < 1 || config.ipEnd > 254) {
    missing.push('VM_POOL_IP_START/VM_POOL_IP_END');
  }
  if (!parseVlanMaskBits(config.networkMask)) {
    missing.push('VM_POOL_NETWORK_MASK');
  }
  if (missing.length) {
    throw new Error(`Invalid VM pool provisioning configuration: ${missing.join(', ')}`);
  }
};

export const listPoolIpAddresses = config => {
  if (!config.ipPrefix) {
    return [];
  }
  const addresses = [];
  for (let octet = config.ipStart; octet <= config.ipEnd; octet += 1) {
    addresses.push(`${config.ipPrefix}.${octet}`);
  }
  return addresses;
};

export const buildCloudInitIpConfig = ({ ipAddress, networkMask, gateway }) => {
  if (!ipAddress || !networkMask || !gateway) {
    return null;
  }
  const mask = String(networkMask).startsWith('/') ? networkMask : `/${networkMask}`;
  return `ip=${ipAddress}${mask},gw=${gateway}`;
};

export const sanitizeVmTag = input =>
  String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

export const mergeVmTags = (...tagValues) => {
  const tags = [];
  for (const value of tagValues) {
    for (const rawTag of String(value ?? '').split(/[;,]/)) {
      const tag = sanitizeVmTag(rawTag);
      if (tag && !tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }
  return tags.length ? tags.join(';') : null;
};

export const buildPoolModelTag = proxmoxTemplateVmid => `model-${Number(proxmoxTemplateVmid)}`;

export const buildPoolVmTags = proxmoxTemplateVmid =>
  mergeVmTags(VM_POOL_TAG, buildPoolModelTag(proxmoxTemplateVmid));

export const escapePowerShellSingleQuotedString = value =>
  String(value ?? '').replace(/'/g, "''");

export const buildWindowsApplyLabIdentityCommand = ({
  ipAddress,
  prefixLength,
  gateway,
  dnsServers = [],
  username,
  password
}) => {
  const lines = [
    '$ErrorActionPreference = "Stop"'
  ];

  if (password) {
    lines.push(
      `Set-LocalUser -Name '${escapePowerShellSingleQuotedString(username)}' -Password (ConvertTo-SecureString '${escapePowerShellSingleQuotedString(password)}' -AsPlainText -Force)`
    );
  }

  if (ipAddress && prefixLength && gateway) {
    const dnsList = dnsServers.length
      ? `@(${dnsServers.map(server => `'${escapePowerShellSingleQuotedString(server)}'`).join(', ')})`
      : '@()';
    lines.push(
      "$adapter = Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select-Object -First 1",
      'if (-not $adapter) { throw "No active network adapter found" }',
      '$idx = $adapter.ifIndex',
      'Remove-NetIPAddress -InterfaceIndex $idx -Confirm:$false -ErrorAction SilentlyContinue',
      "Remove-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue",
      `New-NetIPAddress -InterfaceIndex $idx -IPAddress '${escapePowerShellSingleQuotedString(ipAddress)}' -PrefixLength ${Number(prefixLength)} -DefaultGateway '${escapePowerShellSingleQuotedString(gateway)}'`,
      `$dns = ${dnsList}`,
      'if ($dns.Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $dns }'
    );
  }

  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', lines.join('; ')];
};
