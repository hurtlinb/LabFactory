const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
export const windowsPoolOs = os => ['windows11', 'windows-server'].includes(os);
export const powershellCommand = script => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')
];

export function poolLabNetwork(net0, settings, definition) {
  const bridge = String(settings.network_bridge ?? 'vmbr0').trim();
  const tag = Number(definition.vlan_tag ?? settings.network_vlan_tag ?? 0);
  if (!bridge || /[,\s]/.test(bridge) || !Number.isInteger(tag) || tag < 0 || tag > 4094) {
    throw new Error('Invalid lab bridge or VLAN for pooled VM');
  }
  if (!/^(?:virtio|e1000|e1000e|rtl8139|vmxnet3)=[0-9a-f:]{17}(?:,|$)/i.test(net0 ?? '')) {
    throw new Error('Cannot identify pooled VM network interface');
  }
  // Preserve the MAC/device while switching the network and link together.
  const parts = net0.split(',').filter(part => !/^(bridge|tag|trunks|link_down|firewall)=/.test(part));
  parts.push(`bridge=${bridge}`, `firewall=${settings.network_firewall ? 1 : 0}`);
  if (tag) parts.push(`tag=${tag}`);
  parts.push('link_down=0');
  return parts.join(',');
}

// QGA works over the hypervisor channel: no IP address or guest password is needed.
export function windowsPoolProbe(entry) {
  return `
$ErrorActionPreference = 'Stop'
$flag = Get-Item 'C:\\ProgramData\\cloudbase-init\\done.flag' -ErrorAction SilentlyContinue
if (-not $flag) { exit 11 }
if ($flag.LastWriteTimeUtc -lt [DateTime]::Parse(${psLiteral(new Date(entry.created_at).toISOString())}).ToUniversalTime()) { exit 12 }
Set-Content -LiteralPath 'C:\\ProgramData\\cloudbase-init\\labfactory-pool-ready.flag' -Value ${psLiteral(entry.ownership_token)} -Encoding ASCII
exit 0
`;
}

export function windowsPoolLabSettings({ token, mac, username, password, ipconfig }) {
  if (!password || !username || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) {
    throw new Error('Prepared Windows VM requires guest credentials and the net0 MAC address');
  }
  const match = /^ip=(\d+\.\d+\.\d+\.\d+)\/(\d+),gw=(\d+\.\d+\.\d+\.\d+)$/.exec(ipconfig);
  if (!match) throw new Error('Prepared Windows VM requires a static lab IPv4 configuration');
  return `
$ErrorActionPreference = 'Stop'
$marker = 'C:\\ProgramData\\cloudbase-init\\labfactory-pool-ready.flag'
if (-not (Test-Path $marker) -or (Get-Content $marker -Raw).Trim() -ne ${psLiteral(token)}) { throw 'Windows pool preparation marker does not match' }
$linkDeadline = [DateTime]::UtcNow.AddSeconds(60)
do {
  $adapter = @(Get-NetAdapter | Where-Object { ($_.MacAddress -replace '-', ':') -eq ${psLiteral(mac)} })
  if ($adapter.Count -ne 1) { throw 'Cannot identify the lab network adapter' }
  if ($adapter[0].Status -eq 'Up') { break }
  if ([DateTime]::UtcNow -ge $linkDeadline) { exit 21 }
  Start-Sleep -Seconds 2
} while ($true)
$user = Get-LocalUser -Name ${psLiteral(username)}
Set-LocalUser -InputObject $user -Password (ConvertTo-SecureString ${psLiteral(password)} -AsPlainText -Force)
Enable-LocalUser -InputObject $user
$idx = $adapter[0].ifIndex
Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
Get-NetRoute -InterfaceIndex $idx -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
New-NetIPAddress -InterfaceIndex $idx -IPAddress ${psLiteral(match[1])} -PrefixLength ${Number(match[2])} -DefaultGateway ${psLiteral(match[3])} | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses ('195.186.4.162','195.186.4.163')
exit 0
`;
}
