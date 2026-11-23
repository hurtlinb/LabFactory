import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canTransition, assertTransition, POOL_VM_STATES, transitionPoolVm } from '../lib/windowsPool/states.js';
import { parseTemplatePoolConfig, computeWindowsDemand, planReplenishment } from '../lib/windowsPool/config.js';
import {
  buildGuestExecRequest, parseGuestExecStatus, parseJsonOutput, evaluateBootstrap, evaluateReadiness,
  buildReadyMarkerScript, validateNetworkAssignment, buildNetworkAssignmentScript, evaluatePreConnect,
  evaluatePostConnect, prefixToMask, stripClixml
} from '../lib/windowsPool/qga.js';
import { buildCustomizationGraph, nextSteps, BARRIER } from '../lib/windowsPool/dependencies.js';
import { vmidCandidates, createProxmoxVmidCheck } from '../lib/windowsPool/vmidAllocator.js';
import { checkPlannedVmids, readWindowsPoolVmidRange, DEFAULT_WINDOWS_POOL_VMID_RANGE } from '../lib/vmidAvailability.js';
import { leaseScopes } from '../lib/windowsPool/leases.js';

// --- States -------------------------------------------------------------------

test('a VM that has entered a lab never returns to the clean stock', () => {
  for (const from of ['configuring', 'assigned', 'quarantined', 'deleting', 'deleted']) {
    assert.equal(canTransition(from, 'ready'), false, `${from} -> ready`);
  }
  assert.equal(canTransition('reserved', 'ready'), true, 'intact reservation released on cancellation');
  assert.equal(canTransition('quarantined', 'deleting'), true);
  assert.equal(canTransition('deleted', 'creating'), false);
  assert.throws(() => assertTransition('ready', 'assigned'), /Forbidden/);
  assert.throws(() => assertTransition('ready', 'bogus'), /Unknown/);
  for (const state of POOL_VM_STATES.filter(s => s !== 'deleted')) {
    assert.ok(canTransition(state, 'quarantined') || state === 'quarantined' || canTransition(state, 'deleting'), state);
  }
});

test('transition: optimistic version control and atomic log entry', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: 0, rows: [] }; } };
  await assert.rejects(transitionPoolVm(db, { id: randomUUID(), from: 'ready', to: 'reserved', version: 3 }),
    error => error.code === 'POOL_VM_STALE');
  assert.equal(calls.length, 1, 'a single statement (UPDATE + event)');
  assert.match(calls[0].sql, /INSERT INTO windows_pool_vm_events/);
  assert.match(calls[0].sql, /version = \$4/);
  await assert.rejects(transitionPoolVm(db, { id: 'x', from: 'ready', to: 'reserved', version: 0, patch: { state: 'ready' } }), /not allowed/);
});

// --- Configuration and replenishment -------------------------------------------

const baseConfig = {
  templateId: randomUUID(), enabled: true, readyTarget: 2, maxCapacity: 6, maxParallelPreparations: 2,
  node: 'peda-pve2', storage: 'ceph-pool', revision: 1, sourceTemplateVmid: 147, cloneMode: 'linked',
  preparationTimeoutSeconds: 1800, assignmentTimeoutSeconds: 900
};

test('template configuration: linked clone required, consistent target and placement', () => {
  assert.equal(parseTemplatePoolConfig(baseConfig).cloneMode, 'linked');
  assert.throws(() => parseTemplatePoolConfig({ ...baseConfig, cloneMode: 'full' }));
  // Global ceiling (migration 036): the reserve of a template is no longer bounded by its own ceiling.
  assert.equal(parseTemplatePoolConfig({ ...baseConfig, readyTarget: 7, maxCapacity: undefined }).readyTarget, 7);
  // Node optional (automatic placement, 2026-11-20); storage still required to enable.
  assert.equal(parseTemplatePoolConfig({ ...baseConfig, node: null }).node, null);
  assert.throws(() => parseTemplatePoolConfig({ ...baseConfig, storage: null }), /requires a storage/);
  assert.equal(parseTemplatePoolConfig({ ...baseConfig, enabled: false, node: null, storage: null }).enabled, false);
  assert.throws(() => parseTemplatePoolConfig({ ...baseConfig, node: 'pve;rm -rf' }));
});

test('Windows demand per template, Linux ignored', () => {
  const t1 = randomUUID(), t2 = randomUUID();
  const vms = [
    { id: '01-a', osType: 'windows-server', templateId: t1 }, { id: '01-b', osType: 'ubuntu', templateId: randomUUID() },
    { id: '02-a', osType: 'windows-server', templateId: t1 }, { id: '01-c', osType: 'windows11', templateId: t2 }
  ];
  assert.deepEqual(computeWindowsDemand(vms), [{ templateId: t1, count: 2 }, { templateId: t2, count: 1 }].sort((a, b) => a.templateId.localeCompare(b.templateId)));
  assert.throws(() => computeWindowsDemand([{ id: 'x', osType: 'windows11' }]), /without a template/);
});

test('replenishment: reserve, demand above the reserve, ceiling, parallelism, suspension', () => {
  const plan = (counts, waitingDemand = 0, extra = {}) => planReplenishment({ config: { ...baseConfig, ...extra }, counts, waitingDemand });
  assert.deepEqual(plan({}), { toStart: 2, blocked: null });
  assert.deepEqual(plan({ ready: 2 }), { toStart: 0, blocked: null });
  assert.equal(plan({ ready: 2 }, 3).toStart, 2, 'demand above the reserve triggers preparations (limited by parallelism)');
  assert.equal(plan({ ready: 2 }, 3, { maxParallelPreparations: 8 }).toStart, 3);
  assert.equal(plan({ ready: 5 }, 3, { maxParallelPreparations: 8 }).toStart, 0, 'stock 5 = demand 3 + reserve 2');
  assert.equal(plan({ ready: 5 }, 5, { maxParallelPreparations: 8 }).toStart, 1, 'missing 2 but ceiling 6 reached after 1');
  assert.deepEqual(plan({ ready: 0 }, 9), { toStart: 2, blocked: 'DEMAND_EXCEEDS_CAPACITY' });
  assert.equal(plan({ preparing: 2 }, 0).toStart, 0, 'preparations in progress count');
  assert.deepEqual(planReplenishment({ config: baseConfig, counts: {}, waitingDemand: 1, paused: true }), { toStart: 0, blocked: 'POOL_PAUSED' });
  assert.deepEqual(planReplenishment({ config: { ...baseConfig, enabled: false }, counts: {}, waitingDemand: 1 }), { toStart: 0, blocked: 'TEMPLATE_DISABLED' });
});

// Migration 036: the ceiling is global, shared by every template (stock of the others counted).
test('replenishment: global ceiling shared by the templates', () => {
  const config = { ...baseConfig, readyTarget: 5, maxParallelPreparations: 10, maxCapacity: undefined };
  assert.equal(planReplenishment({ config, counts: {}, maxCapacity: 8, otherStock: 6 }).toStart, 2, '8 - 6 VMs of the other templates');
  assert.equal(planReplenishment({ config, counts: { ready: 1 }, maxCapacity: 8, otherStock: 7 }).toStart, 0, 'pool full');
  assert.equal(planReplenishment({ config, counts: {}, maxCapacity: 50 }).toStart, 5);
  assert.equal(planReplenishment({ config, counts: {}, waitingDemand: 9, maxCapacity: 8 }).blocked, 'DEMAND_EXCEEDS_CAPACITY');
});

// --- QGA contract ----------------------------------------------------------------

test('QGA: secrets passed through stdin, never on the command line', () => {
  const body = buildGuestExecRequest('Write-Output 1', { input: { password: 'S3cret!' } });
  assert.equal(body.command[0], 'powershell.exe');
  assert.ok(!JSON.stringify(body.command).includes('S3cret'));
  assert.equal(JSON.parse(body['input-data']).password, 'S3cret!');
  const decoded = Buffer.from(body.command.at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /ErrorActionPreference='Stop'/);
  const script = buildNetworkAssignmentScript({ mac: 'BC:24:11:AD:43:3E', ipAddress: '10.10.72.121', prefixLength: 25, gateway: '10.10.72.1', dnsServers: ['195.186.4.162'] });
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(script, /EnableDHCP -Value 0/);
  assert.match(script, /mask=255\.255\.255\.128/);
});

test('QGA: redaction and CLIXML cleanup of the results', () => {
  const clixml = '#< CLIXML\r\n<Objs><S S="Error">#IP verification failed_x000D__x000A_</S><Obj S="progress"></Obj></Objs>';
  assert.equal(stripClixml(clixml), '#IP verification failed');
  const parsed = parseGuestExecStatus({ exited: 1, exitcode: 1, 'out-data': '', 'err-data': 'bad pw S3cret!' }, { secrets: ['S3cret!'] });
  assert.equal(parsed.stderr, 'bad pw [redacted]');
  assert.deepEqual(parseGuestExecStatus({ exited: 0 }), { exited: false });
  assert.throws(() => parseJsonOutput(parsed), error => error.code === 'GUEST_COMMAND_FAILED');
  assert.deepEqual(parseJsonOutput({ exited: true, exitCode: 0, stdout: 'noise\r\n{"a":1}\r\n' }), { a: 1 });
});

// Probe observed in P0 (VM 151, linked clone) once the bootstrap was finished.
const p0Probe = {
  state: 'IMAGE_STATE_COMPLETE', setup: 0, oobe: 0, cloudbase: 'Stopped', flag: true,
  plugins: { ConfigWinRMListenerPlugin: 1, SetUserPasswordPlugin: 1, LocalScriptsPlugin: 1, NetworkConfigPlugin: 1 },
  errorCount: 0, doneLog: true, nic: [{ MacAddress: 'BC-24-11-AD-43-3E', Status: 'Disconnected' }], pendingCbs: false, pendingWU: false
};

test('readiness: the agent answering is not enough; errors and connected NIC are fatal', () => {
  assert.equal(evaluateBootstrap(null).code, 'AGENT_UNAVAILABLE');
  assert.deepEqual(evaluateBootstrap({ ...p0Probe, state: 'IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE', oobe: 1 }),
    { code: 'SETUP_IN_PROGRESS', fatal: false, ready: false, detail: 'IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE' });
  assert.equal(evaluateBootstrap({ ...p0Probe, cloudbase: 'Running', errorCount: -1 }).code, 'CLOUDBASE_RUNNING');
  assert.equal(evaluateBootstrap({ ...p0Probe, flag: false }).code, 'CLOUDBASE_RUNNING', 'done.flag alone is not enough, and its absence blocks');
  const errors = evaluateBootstrap({ ...p0Probe, errorCount: 1 });
  assert.equal(errors.code, 'BOOTSTRAP_ERRORS'); assert.equal(errors.fatal, true);
  assert.equal(evaluateBootstrap({ ...p0Probe, plugins: { ...p0Probe.plugins, NetworkConfigPlugin: 2 } }).code, 'PLUGIN_STATE_INVALID');
  assert.equal(evaluateBootstrap({ ...p0Probe, pendingWU: true }).code, 'BOOTSTRAP_REBOOT_PENDING');
  assert.equal(evaluateBootstrap({ ...p0Probe, nic: [{ Status: 'Up' }] }).code, 'NIC_CONNECTED');
  assert.equal(evaluateBootstrap(p0Probe).ready, true);
});

test('readiness: marker tied to the VM and the revision (inherited marker = fatal)', () => {
  const poolVmId = randomUUID();
  assert.equal(evaluateReadiness(p0Probe, { poolVmId, revision: 1 }).code, 'MARKER_MISSING');
  assert.equal(evaluateReadiness({ ...p0Probe, marker: { poolVmId, revision: 1 } }, { poolVmId, revision: 1 }).ready, true);
  const inherited = evaluateReadiness({ ...p0Probe, marker: { poolVmId: randomUUID(), revision: 1 } }, { poolVmId, revision: 1 });
  assert.deepEqual([inherited.code, inherited.fatal], ['MARKER_MISMATCH', true]);
  assert.equal(evaluateReadiness({ ...p0Probe, marker: { poolVmId, revision: 2 } }, { poolVmId, revision: 1 }).code, 'MARKER_MISMATCH');
  assert.equal(evaluateReadiness({ ...p0Probe, marker: { invalid: true } }, { poolVmId, revision: 1 }).code, 'MARKER_MISMATCH');
  assert.match(buildReadyMarkerScript({ poolVmId, revision: 1 }), /StartupType Disabled/);
  assert.throws(() => buildReadyMarkerScript({ poolVmId: "x'; rm", revision: 1 }), /poolVmId/);
});

test('network assignment: strict validation (injection, subnet, gateway)', () => {
  const ok = { mac: 'bc:24:11:ad:43:3e', ipAddress: '10.10.72.121', prefixLength: 25, gateway: '10.10.72.1', dnsServers: ['195.186.4.162', '195.186.4.163'] };
  assert.equal(validateNetworkAssignment(ok).mac, 'BC-24-11-AD-43-3E');
  assert.equal(prefixToMask(25), '255.255.255.128');
  assert.equal(prefixToMask(24), '255.255.255.0');
  assert.throws(() => validateNetworkAssignment({ ...ok, ipAddress: "10.0.0.1'; Remove-Item" }), /IP/);
  assert.throws(() => validateNetworkAssignment({ ...ok, gateway: '10.10.72.129' }), /outside the subnet/);
  assert.throws(() => validateNetworkAssignment({ ...ok, gateway: ok.ipAddress }), /gateway/);
  assert.throws(() => validateNetworkAssignment({ ...ok, dnsServers: [] }), /DNS/);
  assert.throws(() => validateNetworkAssignment({ ...ok, mac: 'zz' }), /MAC/);
  assert.throws(() => buildNetworkAssignmentScript(ok, { adminUser: 'a b' }), /account/);
});

test('assignment verification: APIPA tolerated with the link down, single address after connecting (P0 defect)', () => {
  const params = { mac: 'BC:24:11:AD:43:3E', ipAddress: '10.10.72.121', prefixLength: 25, gateway: '10.10.72.1', dnsServers: ['195.186.4.162', '195.186.4.163'] };
  const good = { nic: 'Disconnected', dhcp: 'Disabled', enableDhcp: 0, gateways: ['10.10.72.1'], dns: ['195.186.4.162', '195.186.4.163'],
    addresses: [{ ip: '169.254.172.144', prefix: 16 }, { ip: '10.10.72.121', prefix: 25 }] };
  assert.equal(evaluatePreConnect(good, params).ready, true);
  // State observed in P0 before the fix: static IP added but DHCP still enabled.
  const p0Defect = evaluatePreConnect({ ...good, dhcp: 'Enabled', enableDhcp: 1 }, params);
  assert.deepEqual([p0Defect.code, p0Defect.fatal], ['ASSIGNMENT_INVALID', true]);
  assert.match(evaluatePreConnect({ ...good, addresses: [...good.addresses, { ip: '10.10.72.50', prefix: 25 }] }, params).detail, /extra/);
  assert.match(evaluatePreConnect({ ...good, dns: ['195.186.4.162'] }, params).detail, /DNS/);
  assert.equal(evaluatePostConnect({ state: 'Preferred', count: 1 }).ready, true);
  assert.equal(evaluatePostConnect({ state: 'Duplicate', count: 1 }).code, 'ASSIGNMENT_INVALID');
  assert.equal(evaluatePostConnect({ state: 'Preferred', count: 2 }).code, 'ASSIGNMENT_INVALID');
});

// --- Dependency graph -------------------------------------------------------------

const lab = [
  { vmid: 70001, osType: 'windows', fromPool: true, ipAddress: '10.10.72.10', domainRole: 'controller', domainName: 'a.lab' },
  { vmid: 70002, osType: 'windows', fromPool: true, ipAddress: '10.10.72.11', domainRole: 'member', domainName: 'a.lab', hasTaskBlocks: true },
  { vmid: 70003, osType: 'windows', fromPool: true, ipAddress: '10.10.73.10', domainRole: 'controller', domainName: 'a.lab' },
  { vmid: 70004, osType: 'windows', fromPool: true, ipAddress: '10.10.73.11', domainRole: 'member', domainName: 'a.lab' },
  { vmid: 50001, osType: 'linux', ipAddress: '10.10.72.20' }
];

test('graph: AD scoped by domain and network, not by the whole lab', () => {
  const graph = buildCustomizationGraph(lab);
  assert.deepEqual([...graph.get('70002:domain').deps].sort(), ['70001:domain', '70002:reconnect']);
  assert.deepEqual([...graph.get('70004:domain').deps].sort(), ['70003:domain', '70004:reconnect']);
  assert.deepEqual([...graph.get('70001:assign-network').deps], []);
  assert.deepEqual([...graph.get('70001:connect').deps], ['70001:assign-network'], 'connect only after network configuration');
  assert.throws(() => buildCustomizationGraph([lab[1]]), /without a controller/);
});

test('graph: independent steps run without waiting for the slowest VM', () => {
  const graph = buildCustomizationGraph(lab);
  const statuses = new Map();
  let { runnable } = nextSteps(graph, statuses);
  assert.deepEqual(runnable.sort(), ['50001:linux', '70001:assign-network', '70002:assign-network', '70003:assign-network', '70004:assign-network']);
  // Workstation 1 is fast, workstation 2 is slow: the member of 1 joins without waiting for 2.
  for (const id of graph.keys()) if (id.startsWith('70001:') || (id.startsWith('70002:') && !id.endsWith(':domain') && !id.endsWith(':tasks'))) statuses.set(id, 'succeeded');
  ({ runnable } = nextSteps(graph, statuses));
  assert.ok(runnable.includes('70002:domain'));
  assert.ok(!runnable.includes(BARRIER), 'fault injection waits for every preparation');
});

test('graph: preparation failure blocks fault injection everywhere (barrier kept)', () => {
  const graph = buildCustomizationGraph(lab);
  const statuses = new Map([...graph.keys()].filter(id => id !== BARRIER && !id.endsWith(':tasks')).map(id => [id, 'succeeded']));
  statuses.set('70004:domain', 'failed');
  assert.deepEqual(nextSteps(graph, statuses).blocked, [BARRIER]);
  statuses.set('70004:domain', 'succeeded');
  assert.deepEqual(nextSteps(graph, statuses).runnable, [BARRIER]);
});

// --- VMIDs and leases ----------------------------------------------------------------

test('VMID candidates: circular range, used IDs skipped, no immediate reuse', () => {
  const used = new Set([70001, 70003]);
  assert.deepEqual([...vmidCandidates({ min: 70000, max: 70004, lastVmid: 70002, usedVmids: used })], [70004, 70000, 70002]);
  assert.deepEqual([...vmidCandidates({ min: 70000, max: 70001 })], [70000, 70001]);
  assert.throws(() => [...vmidCandidates({ min: 5, max: 4 })], /range/);
});

// Simulated Proxmox with the behaviours measured in P2 on ceph-pool.
const vmidProxmox = ({ nextid = id => id, guests = [], volumes = [], storage = 'ok', calls = [] } = {}) => async (path, options = {}) => {
  calls.push({ path, options });
  const match = path.match(/^cluster\/nextid\?vmid=(\d+)$/);
  if (match) { const r = nextid(Number(match[1])); if (r instanceof Error) throw r; return r; }
  if (path === 'cluster/resources?type=vm') return guests;
  const volume = path.match(/^nodes\/peda-pve2\/storage\/ceph-pool\/content\/(.+)$/);
  if (volume) {
    const volid = decodeURIComponent(volume[1]);
    if (storage === 'timeout') throw new Error('Proxmox HTTP 596: Connection timed out');
    if (volumes.includes(volid)) return { format: 'raw', size: 1 };
    throw new Error(`Proxmox HTTP 500: rbd error: rbd: error opening image ${volid.split(':')[1]}: (2) No such file or directory`);
  }
  throw new Error('unexpected path ' + path);
};

test('pool VMID check: registry, inventory and volumes must all agree (fail closed)', async () => {
  const check = request => createProxmoxVmidCheck({ request, node: 'peda-pve2', storage: 'ceph-pool' });
  assert.equal(await check(vmidProxmox())(70010), 70010);
  // Guest invisible to the inventory but known to the registry.
  await assert.rejects(check(vmidProxmox({ nextid: () => new Error('VM 70010 already exists') }))(70010), /already exists/);
  await assert.rejects(check(vmidProxmox({ nextid: () => 70011 }))(70010), /registry/);
  // Visible guest (e.g. another lab, a template) even if the registry said yes.
  await assert.rejects(check(vmidProxmox({ guests: [{ vmid: 70010, name: 'other-lab', type: 'qemu', node: 'peda-pve1' }] }))(70010), /other-lab/);
  // Orphan disks left by an interrupted clone (case observed in P0).
  await assert.rejects(check(vmidProxmox({ volumes: ['ceph-pool:vm-70010-disk-0'] }))(70010), /vm-70010-disk-0 present/);
  await assert.rejects(check(vmidProxmox({ volumes: ['ceph-pool:vm-70010-disk-2'] }))(70010), /present/);
  await assert.rejects(check(vmidProxmox({ volumes: ['ceph-pool:vm-70010-cloudinit'] }))(70010), /cloudinit present/);
  await assert.rejects(check(async () => null)(70010), /registry|Invalid/);
  assert.throws(() => createProxmoxVmidCheck({ request: async () => 1, node: 'peda-pve2' }), /Incomplete/);
});

test('pool VMID check: targeted volume lookups, storage unavailable = allocation postponed', async () => {
  const calls = [];
  await createProxmoxVmidCheck({ request: vmidProxmox({ calls }), node: 'peda-pve2', storage: 'ceph-pool' })(70020);
  const volumeCalls = calls.filter(call => call.path.includes('/content/'));
  assert.deepEqual(volumeCalls.map(call => decodeURIComponent(call.path.split('/content/')[1])),
    ['ceph-pool:vm-70020-disk-0', 'ceph-pool:vm-70020-disk-1', 'ceph-pool:vm-70020-disk-2', 'ceph-pool:vm-70020-disk-3', 'ceph-pool:vm-70020-cloudinit']);
  assert.ok(volumeCalls.every(call => call.options.timeoutMs === 15_000));
  assert.ok(!calls.some(call => call.path.endsWith('/content')), 'never the full listing (~30 s on ceph-pool, HTTP 596)');
  await assert.rejects(createProxmoxVmidCheck({ request: vmidProxmox({ storage: 'timeout' }), node: 'peda-pve2', storage: 'ceph-pool' })(70020),
    error => error.code === 'VOLUME_CHECK_UNAVAILABLE');
});

test('Terraform never creates a VMID in the pool range, even if Proxmox says it is free', async () => {
  const plan = vmids => ({ format_version: '1.2', resource_changes: vmids.map((vmid, i) => ({
    address: `proxmox_vm_qemu.lab_vm[${i}]`, type: 'proxmox_vm_qemu', change: { actions: ['create'], before: null, after: { vmid } } })) });
  const free = async () => [];
  await checkPlannedVmids(plan([59990, 60100]), free, async id => id, [DEFAULT_WINDOWS_POOL_VMID_RANGE]);
  await assert.rejects(checkPlannedVmids(plan([59990, 70000]), free, async id => id, [DEFAULT_WINDOWS_POOL_VMID_RANGE]),
    /VMID 70000 reserved for the Windows pool \(70000-79999\)/);
  let inventoryCalled = false;
  await assert.rejects(checkPlannedVmids(plan([79999]), async () => { inventoryCalled = true; return []; }, async id => id, [DEFAULT_WINDOWS_POOL_VMID_RANGE]));
  assert.equal(inventoryCalled, false, 'blocked before any Proxmox call');
  // Updating an existing VM (no creation) is not affected.
  await checkPlannedVmids({ format_version: '1.2', resource_changes: [{ type: 'proxmox_vm_qemu', change: { actions: ['update'], after: { vmid: 70001 } } }] }, free, async id => id, [DEFAULT_WINDOWS_POOL_VMID_RANGE]);
});

test('pool range read for Terraform: configured value, default only if the migration is missing', async () => {
  assert.deepEqual(await readWindowsPoolVmidRange({ query: async () => ({ rows: [{ vmid_min: 71000, vmid_max: 71999 }] }) }),
    { name: 'Windows pool', min: 71000, max: 71999 });
  assert.equal(await readWindowsPoolVmidRange({ query: async () => { throw Object.assign(new Error('no table'), { code: '42P01' }); } }), DEFAULT_WINDOWS_POOL_VMID_RANGE);
  await assert.rejects(readWindowsPoolVmidRange({ query: async () => { throw new Error('connection lost'); } }), /creation blocked/);
});

test('lease scopes: cluster always, node and storage if known', () => {
  assert.deepEqual(leaseScopes(), ['cluster']);
  assert.deepEqual(leaseScopes({ node: 'peda-pve2', storage: 'ceph-pool' }), ['cluster', 'node:peda-pve2', 'storage:ceph-pool']);
});

// User decision 2026-11-20: no reserve refill while other labs are in progress; the waiting
// labs are still served (otherwise they could wait forever).
test('replenishment: reserve on hold while labs are busy, waiting demand always served', () => {
  const config = { ...baseConfig, enabled: true, readyTarget: 4, maxCapacity: 10, maxParallelPreparations: 10 };
  assert.deepEqual(planReplenishment({ config, counts: { ready: 1 }, holdReserve: true }), { toStart: 0, blocked: null, onHold: 'LABS_BUSY' });
  assert.deepEqual(planReplenishment({ config, counts: { ready: 1 }, waitingDemand: 3, holdReserve: true }), { toStart: 2, blocked: null, onHold: 'LABS_BUSY' });
  assert.deepEqual(planReplenishment({ config, counts: { ready: 4 }, holdReserve: true }), { toStart: 0, blocked: null }, 'reserve full: nothing on hold');
  assert.deepEqual(planReplenishment({ config, counts: { ready: 1 } }), { toStart: 3, blocked: null });
});

// Storage deduced from the Proxmox template on the first activation from the VM Templates page
// (bug 2026-11-23: regex without its backslash, never any disk found -> "storage unknown").
test('template disk storage: system disk of the real templates 152 and 147', async () => {
  const { templateDiskStorage } = await import('../lib/windowsPool/proxmox.js');
  assert.equal(templateDiskStorage({
    tpmstate0: 'ceph-pool:base-152-disk-2,size=4M,version=v2.0',
    efidisk0: 'ceph-pool:base-152-disk-0,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=1M',
    scsi0: 'ceph-pool:base-152-disk-1,iothread=1,size=60G',
    ide2: 'ceph-pool:vm-152-cloudinit,media=cdrom',
    ide0: 'none,media=cdrom'
  }), 'ceph-pool');
  assert.equal(templateDiskStorage({ ide2: 'local:iso/x.iso,media=cdrom', scsi10: 'fast:base-1-disk-2', scsi2: 'ssd:base-1-disk-1' }), 'ssd', 'numeric order');
  assert.equal(templateDiskStorage({ virtio0: 'local-lvm:base-9-disk-0,size=32G' }), 'local-lvm');
  assert.equal(templateDiskStorage({ ide2: 'none,media=cdrom', efidisk0: 'ceph-pool:x' }), null);
  assert.equal(templateDiskStorage(null), null);
});

// Migration 037: the parallel preparations are global (all the templates together).
test('replenishment: parallel preparations shared by the templates', () => {
  const config = { ...baseConfig, readyTarget: 10, maxParallelPreparations: 4, maxCapacity: undefined };
  assert.equal(planReplenishment({ config, counts: {}, maxCapacity: 50, otherInFlight: 3 }).toStart, 1, '4 - 3 preparations of the other templates');
  assert.equal(planReplenishment({ config, counts: { preparing: 1 }, maxCapacity: 50, otherInFlight: 3 }).toStart, 0);
  assert.equal(planReplenishment({ config, counts: {}, maxCapacity: 50 }).toStart, 4);
});

// Language components on demand (dev lab 200, 2026-11-23): disabled with the Windows Update pause.
test('Windows Update pause: language component tasks disabled and verified', async () => {
  const { buildWindowsUpdatePauseScript, evaluateWindowsUpdatePause } = await import('../lib/windowsPool/qga.js');
  const script = buildWindowsUpdatePauseScript('windows-server');
  assert.ok(script.includes("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\LanguageComponentsInstaller\\'"), 'language component tasks targeted');
  assert.match(script, /Disable-ScheduledTask/);
  const today = '2026-11-23';
  const ok = { start: today, PauseQualityUpdatesStartTime: today };
  assert.equal(evaluateWindowsUpdatePause({ ...ok, languageTasks: [{ name: 'Installation', state: 'Disabled' }, { name: 'ReconcileLanguageResources', state: 'Disabled' }] }, 'windows-server').ready, true);
  assert.equal(evaluateWindowsUpdatePause({ ...ok, languageTasks: { name: 'Installation', state: 'Disabled' } }, 'windows-server').ready, true, 'single task serialized as an object');
  assert.equal(evaluateWindowsUpdatePause(ok, 'windows-server').ready, true, 'no such task on this image: nothing to disable');
  const refused = evaluateWindowsUpdatePause({ ...ok, languageTasks: [{ name: 'Installation', state: 'Ready' }] }, 'windows-server');
  assert.deepEqual([refused.ready, refused.code], [false, 'WU_PAUSE_FAILED']);
  assert.match(refused.detail, /Installation=Ready/);
});
