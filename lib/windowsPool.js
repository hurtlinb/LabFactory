const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
export const windowsPoolOs = os => ['windows11', 'windows-server'].includes(os);
export const powershellCommand = script => [
  'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')
];

// QGA works over the hypervisor channel: no IP address or guest password is needed.
export function windowsPoolProbe(entry) {
  return `
$ErrorActionPreference = 'Stop'
$setup = Get-ItemProperty 'HKLM:\\SYSTEM\\Setup'
$image = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup\\State'
if ($image.ImageState -ne 'IMAGE_STATE_COMPLETE' -or [int]$setup.SystemSetupInProgress -ne 0 -or [int]$setup.OOBEInProgress -ne 0) { exit 10 }
if (Get-Process -Name 'sysprep','setup','setuphost' -ErrorAction SilentlyContinue) { exit 10 }
$flag = Get-Item 'C:\\ProgramData\\cloudbase-init\\done.flag' -ErrorAction SilentlyContinue
if (-not $flag -or $flag.LastWriteTimeUtc -lt [DateTime]::Parse(${psLiteral(new Date(entry.created_at).toISOString())}).ToUniversalTime()) { exit 11 }
$services = @(Get-Service -Name 'cloudbase-init','cloudbaseinit' -ErrorAction SilentlyContinue)
if ($services.Count -eq 0 -or @($services | Where-Object Status -ne 'Stopped').Count -gt 0) { exit 12 }
$services | Set-Service -StartupType Disabled
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
$image = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Setup\\State'
if ($image.ImageState -ne 'IMAGE_STATE_COMPLETE') { throw 'Windows setup is not complete' }
$user = Get-LocalUser -Name ${psLiteral(username)}
Set-LocalUser -InputObject $user -Password (ConvertTo-SecureString ${psLiteral(password)} -AsPlainText -Force)
Enable-LocalUser -InputObject $user
$adapter = @(Get-NetAdapter | Where-Object { ($_.MacAddress -replace '-', ':') -eq ${psLiteral(mac)} })
if ($adapter.Count -ne 1) { throw 'Cannot identify the lab network adapter' }
$idx = $adapter[0].ifIndex
Set-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
Get-NetRoute -InterfaceIndex $idx -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
New-NetIPAddress -InterfaceIndex $idx -IPAddress ${psLiteral(match[1])} -PrefixLength ${Number(match[2])} -DefaultGateway ${psLiteral(match[3])} | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses ('195.186.4.162','195.186.4.163')
exit 0
`;
}
