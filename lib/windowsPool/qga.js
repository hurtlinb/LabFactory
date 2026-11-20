// QEMU Guest Agent (QGA) contract for the Windows pool, qualified in P0
// (template 147 / Windows Server 2022, Cloudbase-Init 1.1.6, QGA 110.0.2).
// Builds requests and interprets results only: no network call here.

export const GUEST_TIMEOUTS = Object.freeze({
  probeMs: 60_000, // one probe command
  assignmentMs: 120_000, // network configuration + password
  pollIntervalMs: 1_500, // exec-status polling
  agentRetryMs: 8_000 // agent unavailable (normal reboots during specialize/OOBE)
});

export const READY_MARKER_PATH = 'C:\\ProgramData\\LabFactory\\pool-ready.json';
const CLOUDBASE_PLUGINS = ['NetworkConfigPlugin', 'SetUserPasswordPlugin', 'ConfigWinRMListenerPlugin', 'LocalScriptsPlugin'];

// Result codes. fatal = quarantine (no automatic retry).
export const GUEST_CODES = Object.freeze({
  AGENT_UNAVAILABLE: { fatal: false },
  SETUP_IN_PROGRESS: { fatal: false },
  CLOUDBASE_RUNNING: { fatal: false },
  MARKER_MISSING: { fatal: false },
  READY: { fatal: false },
  BOOTSTRAP_ERRORS: { fatal: true },
  PLUGIN_STATE_INVALID: { fatal: true },
  BOOTSTRAP_REBOOT_PENDING: { fatal: true },
  NIC_CONNECTED: { fatal: true },
  NIC_MISMATCH: { fatal: true },
  MARKER_MISMATCH: { fatal: true },
  ASSIGNMENT_INVALID: { fatal: true },
  WU_PAUSE_FAILED: { fatal: true },
  GUEST_COMMAND_FAILED: { fatal: true }
});

const verdict = (code, detail) => ({ code, fatal: GUEST_CODES[code].fatal, ready: code === 'READY', ...(detail ? { detail } : {}) });

// --- Execution -------------------------------------------------------------

// Request body for POST nodes/{node}/qemu/{vmid}/agent/exec. Secrets go through
// stdin (input-data), never on the command line (visible in the guest's process list).
export function buildGuestExecRequest(script, { input } = {}) {
  if (typeof script !== 'string' || !script.trim()) throw new Error('Empty guest script');
  const prelude = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';";
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  const body = { command: ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded] };
  if (input !== undefined) {
    const data = typeof input === 'string' ? input : JSON.stringify(input);
    if (Buffer.byteLength(data) > 60_000) throw new Error('Guest input too large');
    body['input-data'] = data;
  }
  return body;
}

export function redact(text, secrets = []) {
  let output = String(text ?? '');
  for (const secret of secrets) if (secret) output = output.split(String(secret)).join('[redacted]');
  return output;
}

// Removes the PowerShell CLIXML envelope (progress records, serialized errors).
export function stripClixml(text) {
  const value = String(text ?? '');
  const start = value.indexOf('#< CLIXML');
  if (start === -1) return value;
  const xml = value.slice(start);
  const errors = [...xml.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(match => match[1]
    .replace(/_x000D__x000A_/g, '\n').replace(/_x000[DA]_/g, '').trim()).filter(Boolean);
  return (value.slice(0, start) + errors.join('\n')).trim();
}

// Interprets the response of agent/exec-status.
export function parseGuestExecStatus(status, { secrets = [] } = {}) {
  if (!status || typeof status !== 'object') throw new Error('Invalid exec-status response');
  if (!status.exited) return { exited: false };
  return {
    exited: true,
    exitCode: Number(status.exitcode),
    stdout: redact(status['out-data'] ?? '', secrets),
    stderr: redact(stripClixml(status['err-data'] ?? ''), secrets).slice(0, 4000)
  };
}

export function parseJsonOutput(result) {
  if (!result?.exited || result.exitCode !== 0) {
    throw Object.assign(new Error(`Guest command failed (code ${result?.exitCode}): ${result?.stderr ?? ''}`.trim()), { code: 'GUEST_COMMAND_FAILED' });
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  try { return JSON.parse(line); } catch { throw Object.assign(new Error('Unreadable guest JSON output'), { code: 'GUEST_COMMAND_FAILED' }); }
}

// --- Readiness ----------------------------------------------------------------

export const READINESS_PROBE_SCRIPT = String.raw`
$s=Get-ItemProperty 'HKLM:\SYSTEM\Setup';
$state=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State').ImageState;
$log='C:\Program Files\Cloudbase Solutions\Cloudbase-Init\log\cloudbase-init.log';
$plugins=@{}; Get-ChildItem 'HKLM:\SOFTWARE\Cloudbase Solutions\Cloudbase-Init' -Recurse -ErrorAction SilentlyContinue | Where-Object PSChildName -eq 'Plugins' | ForEach-Object {$k=$_; foreach($n in $k.GetValueNames()){$plugins[$n]=$k.GetValue($n)}};
$marker=$null; if(Test-Path '${READY_MARKER_PATH}'){ try { $marker=Get-Content '${READY_MARKER_PATH}' -Raw | ConvertFrom-Json } catch { $marker=@{invalid=$true} } };
[ordered]@{
 state=$state; setup=$s.SystemSetupInProgress; oobe=$s.OOBEInProgress;
 cloudbase=(Get-Service 'cloudbase-init').Status.ToString();
 flag=(Test-Path 'C:\ProgramData\cloudbase-init\done.flag');
 plugins=$plugins;
 errorCount=if(Test-Path $log){@(Select-String -Path $log -Pattern ' ERROR | CRITICAL |Traceback').Count}else{-1};
 doneLog=if(Test-Path $log){[bool](Select-String -Path $log -Pattern 'Plugins execution done')}else{$false};
 boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o');
 nic=@(Get-NetAdapter|Select-Object MacAddress,@{n='Status';e={$_.Status.ToString()}});
 pendingCbs=Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending';
 pendingWU=Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired';
 marker=$marker
}|ConvertTo-Json -Depth 4 -Compress`;

// Bootstrap verdict (before the marker): the agent answering, or done.flag alone, is not enough.
export function evaluateBootstrap(probe) {
  if (!probe) return verdict('AGENT_UNAVAILABLE');
  if (probe.state !== 'IMAGE_STATE_COMPLETE' || probe.setup !== 0 || probe.oobe !== 0) {
    return verdict('SETUP_IN_PROGRESS', String(probe.state ?? 'unknown'));
  }
  if (probe.cloudbase !== 'Stopped' || !probe.flag || !probe.doneLog) return verdict('CLOUDBASE_RUNNING');
  if (probe.errorCount !== 0) return verdict('BOOTSTRAP_ERRORS', `errorCount=${probe.errorCount}`);
  const plugins = probe.plugins ?? {};
  if (!CLOUDBASE_PLUGINS.every(name => plugins[name] === 1)) return verdict('PLUGIN_STATE_INVALID');
  if (probe.pendingCbs || probe.pendingWU) return verdict('BOOTSTRAP_REBOOT_PENDING');
  if (!Array.isArray(probe.nic) || !probe.nic.length || !probe.nic.every(nic => nic.Status === 'Disconnected')) {
    return verdict('NIC_CONNECTED');
  }
  return verdict('READY');
}

// Full verdict: bootstrap OK + marker tied to this VM and this revision.
// A marker inherited from the template or from another VM is fatal (identity not guaranteed).
export function evaluateReadiness(probe, { poolVmId, revision }) {
  const bootstrap = evaluateBootstrap(probe);
  if (!bootstrap.ready) return bootstrap;
  const marker = probe.marker;
  if (!marker) return verdict('MARKER_MISSING');
  if (marker.invalid || marker.poolVmId !== poolVmId || Number(marker.revision) !== Number(revision)) {
    return verdict('MARKER_MISMATCH');
  }
  return verdict('READY');
}

// Writes the marker and then disables Cloudbase-Init: it must never re-apply its
// provisional metadata (DHCP, password) after an assignment or a reboot.
export function buildReadyMarkerScript({ poolVmId, revision }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(poolVmId))) throw new Error('Invalid poolVmId');
  if (!Number.isInteger(revision) || revision < 1) throw new Error('Invalid revision');
  return String.raw`
if((Get-Service 'cloudbase-init').Status -ne 'Stopped'){throw 'Cloudbase-Init still running'};
Set-Service 'cloudbase-init' -StartupType Disabled;
New-Item -ItemType Directory -Force -Path 'C:\ProgramData\LabFactory' | Out-Null;
[ordered]@{poolVmId='${poolVmId}';revision=${revision};preparedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress|Set-Content -Encoding UTF8 '${READY_MARKER_PATH}';
[ordered]@{cloudbase=(Get-CimInstance Win32_Service -Filter "Name='cloudbase-init'").StartMode}|ConvertTo-Json -Compress`;
}

// --- Network assignment -------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAC = /^[0-9A-F]{2}([:-][0-9A-F]{2}){5}$/i;
const ipToInt = ip => ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
export const prefixToMask = prefix => {
  const bits = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map(shift => (bits >>> shift) & 255).join('.');
};

export function validateNetworkAssignment({ mac, ipAddress, prefixLength, gateway, dnsServers }) {
  if (!MAC.test(String(mac))) throw new Error('Invalid MAC address');
  if (!IPV4.test(String(ipAddress))) throw new Error('Invalid IP address');
  if (!Number.isInteger(prefixLength) || prefixLength < 8 || prefixLength > 30) throw new Error('Invalid prefix');
  if (!IPV4.test(String(gateway))) throw new Error('Invalid gateway');
  if (!Array.isArray(dnsServers) || !dnsServers.length || dnsServers.length > 4 || !dnsServers.every(dns => IPV4.test(String(dns)))) {
    throw new Error('Invalid DNS servers');
  }
  const mask = prefixLength === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
  if (((ipToInt(ipAddress) & mask) >>> 0) !== ((ipToInt(gateway) & mask) >>> 0)) throw new Error('Gateway outside the subnet');
  if (ipAddress === gateway) throw new Error('The IP address equals the gateway');
  return { mac: mac.toUpperCase().replaceAll(':', '-'), ipAddress, prefixLength, gateway, dnsServers, mask: prefixToMask(prefixLength) };
}

// Configuration with the link down (qualified in P0):
//  - netsh/Set-NetIPInterface do not switch EnableDHCP while the media is disconnected:
//    the registry is written explicitly;
//  - the APIPA address that Windows shows with the link down is tolerated before connecting.
// The password (if provided) is read from stdin: {"password": "..."}.
export function buildNetworkAssignmentScript(params, { setPassword = true, adminUser = 'Administrator' } = {}) {
  const p = validateNetworkAssignment(params);
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(adminUser)) throw new Error('Invalid account');
  const dns = p.dnsServers.map(value => `'${value}'`).join(',');
  return String.raw`
if((Get-CimInstance Win32_Service -Filter "Name='cloudbase-init'").StartMode -ne 'Disabled'){throw 'Cloudbase-Init must be disabled before assignment'};
$nic=@(Get-NetAdapter|Where-Object {$_.MacAddress -eq '${p.mac}'}); if($nic.Count -ne 1){throw 'NIC_MISMATCH'}; $nic=$nic[0];
if($nic.Status.ToString() -ne 'Disconnected'){throw 'NIC_CONNECTED'};
$reg="HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($nic.InterfaceGuid)";
Set-ItemProperty $reg -Name EnableDHCP -Value 0 -Type DWord;
Set-NetIPInterface -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -Dhcp Disabled;
Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -ne '${p.ipAddress}' -and $_.IPAddress -notlike '169.254.*'} | Remove-NetIPAddress -Confirm:$false;
netsh interface ipv4 set address name="$($nic.Name)" source=static address=${p.ipAddress} mask=${p.mask} gateway=${p.gateway} store=persistent | Out-Null; if($LASTEXITCODE -ne 0){throw 'netsh failed'};
Set-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -ServerAddresses ${dns};
${setPassword ? String.raw`$in=[Console]::In.ReadToEnd()|ConvertFrom-Json; if(-not $in.password){throw 'Missing password'}; Set-LocalUser '${adminUser}' -Password (ConvertTo-SecureString $in.password -AsPlainText -Force); $in=$null;` : ''}
$all=@(Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4);
$route=@(Get-NetRoute -InterfaceIndex $nic.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue|ForEach-Object NextHop);
[ordered]@{
 nic=$nic.Status.ToString();
 dhcp=(Get-NetIPInterface -InterfaceIndex $nic.ifIndex -AddressFamily IPv4).Dhcp.ToString();
 enableDhcp=(Get-ItemProperty $reg).EnableDHCP;
 addresses=@($all|ForEach-Object {[ordered]@{ip=$_.IPAddress;prefix=[int]$_.PrefixLength}});
 gateways=$route;
 dns=@((Get-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4).ServerAddresses)
}|ConvertTo-Json -Depth 3 -Compress`;
}

// Verification with the link down, before the Proxmox reconnection.
export function evaluatePreConnect(result, params) {
  const p = validateNetworkAssignment(params);
  const problems = [];
  if (result?.nic !== 'Disconnected') problems.push('NIC not disconnected');
  if (result?.dhcp !== 'Disabled' || Number(result?.enableDhcp) !== 0) problems.push('DHCP still enabled');
  const addresses = result?.addresses ?? [];
  const target = addresses.filter(a => a.ip === p.ipAddress);
  if (target.length !== 1 || target[0].prefix !== p.prefixLength) problems.push('Target IP missing or wrong prefix');
  if (addresses.some(a => a.ip !== p.ipAddress && !a.ip.startsWith('169.254.'))) problems.push('Unexpected extra IPv4 address');
  if (!(result?.gateways ?? []).includes(p.gateway)) problems.push('Gateway missing');
  if ((result?.dns ?? []).join(',') !== p.dnsServers.join(',')) problems.push('DNS differ');
  return problems.length ? verdict('ASSIGNMENT_INVALID', problems.join('; ')) : verdict('READY');
}

// DHCP mode (blueprint VM without ipLastOctet, same behaviour as ipconfig0=ip=dhcp on the
// Terraform side): re-enables DHCP for the NIC (registry + interface), removes any static
// address/route left over, the DNS will come from DHCP. Password through stdin, as for static.
export function buildDhcpAssignmentScript({ mac }, { setPassword = true, adminUser = 'Administrator' } = {}) {
  if (!MAC.test(String(mac))) throw new Error('Invalid MAC address');
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(adminUser)) throw new Error('Invalid account');
  const normalized = mac.toUpperCase().replaceAll(':', '-');
  return String.raw`
if((Get-CimInstance Win32_Service -Filter "Name='cloudbase-init'").StartMode -ne 'Disabled'){throw 'Cloudbase-Init must be disabled before assignment'};
$nic=@(Get-NetAdapter|Where-Object {$_.MacAddress -eq '${normalized}'}); if($nic.Count -ne 1){throw 'NIC_MISMATCH'}; $nic=$nic[0];
if($nic.Status.ToString() -ne 'Disconnected'){throw 'NIC_CONNECTED'};
$reg="HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($nic.InterfaceGuid)";
Get-NetRoute -InterfaceIndex $nic.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue;
Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -PrefixOrigin Manual -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false;
Set-ItemProperty $reg -Name EnableDHCP -Value 1 -Type DWord;
Set-NetIPInterface -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -Dhcp Enabled;
Set-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -ResetServerAddresses;
${setPassword ? String.raw`$in=[Console]::In.ReadToEnd()|ConvertFrom-Json; if(-not $in.password){throw 'Missing password'}; Set-LocalUser '${adminUser}' -Password (ConvertTo-SecureString $in.password -AsPlainText -Force); $in=$null;` : ''}
[ordered]@{
 nic=$nic.Status.ToString();
 dhcp=(Get-NetIPInterface -InterfaceIndex $nic.ifIndex -AddressFamily IPv4).Dhcp.ToString();
 enableDhcp=(Get-ItemProperty $reg).EnableDHCP;
 addresses=@(Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue|ForEach-Object {[ordered]@{ip=$_.IPAddress;prefix=[int]$_.PrefixLength;origin=$_.PrefixOrigin.ToString()}})
}|ConvertTo-Json -Depth 3 -Compress`;
}

export function evaluateDhcpPreConnect(result) {
  const problems = [];
  if (result?.nic !== 'Disconnected') problems.push('NIC not disconnected');
  if (result?.dhcp !== 'Enabled' || Number(result?.enableDhcp) !== 1) problems.push('DHCP not enabled');
  if ((result?.addresses ?? []).some(a => a.origin === 'Manual')) problems.push('Static address left over');
  return problems.length ? verdict('ASSIGNMENT_INVALID', problems.join('; ')) : verdict('READY');
}

// After connecting in DHCP: the NIC address (found by MAC).
export function buildDhcpPostConnectScript({ mac }) {
  if (!MAC.test(String(mac))) throw new Error('Invalid MAC address');
  const normalized = mac.toUpperCase().replaceAll(':', '-');
  return String.raw`$nic=@(Get-NetAdapter|Where-Object {$_.MacAddress -eq '${normalized}'})[0];
[ordered]@{addresses=@(Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue|ForEach-Object {[ordered]@{ip=$_.IPAddress;state=$_.AddressState.ToString();origin=$_.PrefixOrigin.ToString()}})}|ConvertTo-Json -Depth 3 -Compress`;
}

// DHCP: wait for a single leased, Preferred address (not APIPA). Not ready = retry.
export function evaluateDhcpPostConnect(result) {
  const leases = (result?.addresses ?? []).filter(a => a.origin === 'Dhcp' && !String(a.ip).startsWith('169.254.'));
  if (!leases.length) return { ...verdict('SETUP_IN_PROGRESS', 'DHCP lease pending'), ready: false };
  if (leases.length > 1 || leases[0].state !== 'Preferred') return verdict('ASSIGNMENT_INVALID', `DHCP addresses: ${JSON.stringify(leases)}`);
  return { ...verdict('READY'), ipAddress: leases[0].ip };
}

// Windows Update pause, the same policies as the "Pause Windows updates" action of the lab
// details (dashboard/server.js): 35 days from today, then automatic resumption. Feature
// updates also paused on Windows 11. Applied at assignment, NETWORK STILL DISCONNECTED: the
// VM never reaches Windows Update before the pause, and the 35 days start with the lab.
// https://learn.microsoft.com/windows/deployment/update/waas-configure-wufb
export const WINDOWS_UPDATE_PAUSE_DAYS = 35;
export function buildWindowsUpdatePauseScript(osType) {
  const names = ['PauseQualityUpdatesStartTime', ...(osType === 'windows11' ? ['PauseFeatureUpdatesStartTime'] : [])];
  return String.raw`$ErrorActionPreference='Stop';
$p='HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate';$s=(Get-Date).ToString('yyyy-MM-dd');
New-Item -Path $p -Force|Out-Null;
${names.map(name => `New-ItemProperty -Path $p -Name '${name}' -Value $s -PropertyType String -Force|Out-Null;`).join('\n')}
[ordered]@{start=$s;${names.map(name => `${name}=(Get-ItemPropertyValue -Path $p -Name '${name}')`).join(';')}}|ConvertTo-Json -Compress`;
}
export function evaluateWindowsUpdatePause(result, osType) {
  const names = ['PauseQualityUpdatesStartTime', ...(osType === 'windows11' ? ['PauseFeatureUpdatesStartTime'] : [])];
  if (!result?.start || names.some(name => result[name] !== result.start)) {
    return verdict('WU_PAUSE_FAILED', `Windows Update pause not confirmed: ${JSON.stringify(result)}`);
  }
  return verdict('READY');
}

export const buildPostConnectScript = ipAddress => {
  if (!IPV4.test(String(ipAddress))) throw new Error('Invalid IP address');
  return String.raw`$a=Get-NetIPAddress -IPAddress '${ipAddress}' -AddressFamily IPv4;
[ordered]@{state=$a.AddressState.ToString();count=@(Get-NetIPAddress -InterfaceIndex $a.InterfaceIndex -AddressFamily IPv4).Count}|ConvertTo-Json -Compress`;
};

// After connecting: exactly one IPv4 address (no more APIPA, no DHCP lease) and Preferred
// (Duplicate/Tentative = possible conflict on the network).
export function evaluatePostConnect(result) {
  if (result?.state !== 'Preferred') return verdict('ASSIGNMENT_INVALID', `AddressState=${result?.state}`);
  if (result?.count !== 1) return verdict('ASSIGNMENT_INVALID', `Unexpected IPv4 addresses: ${result?.count}`);
  return verdict('READY');
}
