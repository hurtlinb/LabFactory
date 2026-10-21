import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vmModule from 'node:vm';
import { z } from 'zod';
import { applyPoolAssignments, claimPoolVms, reconcileVmPools, proxmoxInventoryPool } from '../lib/vmPool.js';
import { windowsPoolOs, windowsPoolProbe, windowsPoolLabSettings, powershellCommand, poolLabNetwork } from '../lib/windowsPool.js';

const vm = (vmid = 10000) => ({ id: `vm-${vmid}`, vmid, templateId: 'model', cloneSource: '9000', fullClone: true });
const entry = (vmid = 900000, status = 'ready') => ({
  vmid, template_id: 'model', source_vmid: 9000, full_clone: true, node: 'pve', status, ownership_token: 'owned-token',
  created_at: new Date().toISOString(), guest_probe_started_at: new Date().toISOString()
});

test('inventory uses the Proxmox resource pool corresponding to the environment', () => {
  assert.equal(proxmoxInventoryPool('development'), 'pool-dev');
  assert.equal(proxmoxInventoryPool('dev'), 'pool-dev');
  assert.equal(proxmoxInventoryPool('production'), 'pool');
  assert.equal(proxmoxInventoryPool(''), 'pool');
});

function claimDatabase({ entries = [], enabled = true, assignments = {} } = {}) {
  const queries = [];
  let saved = structuredClone(assignments);
  const client = {
    release() {},
    async query(sql, args) {
      queries.push(sql);
      if (sql.startsWith('SELECT pool_assignments')) return { rows: [{ pool_assignments: structuredClone(saved) }] };
      if (sql.startsWith('SELECT pool_enabled')) return { rows: [{ pool_enabled: enabled }] };
      if (sql.startsWith('SELECT p.*')) {
        assert.match(sql, /FOR UPDATE OF p SKIP LOCKED/);
        const found = entries.find(row => row.status === 'ready' && row.source_vmid === args[1] && row.full_clone === args[2]);
        return { rows: found ? [found] : [] };
      }
      if (sql.startsWith('UPDATE vm_pool')) entries.find(row => row.vmid === args[0]).status = 'assigned';
      if (sql.startsWith('UPDATE lab_deployments')) saved = JSON.parse(args[1]);
      return { rows: [] };
    }
  };
  return { connect: async () => client, queries, entries, assignments: () => saved };
}

test('an empty enabled pool waits instead of allowing a direct clone', async () => {
  const db = claimDatabase();
  const result = await claimPoolVms(db, 'lab', [vm()]);
  assert.deepEqual(result.waiting, ['vm-10000']);
  assert.equal(result.vms[0].vmid, 10000);
  assert(db.queries.includes('COMMIT'));
});

test('labs larger than the pool reserve incrementally and reuse reservations after restart', async () => {
  const db = claimDatabase({ entries: [entry()] });
  const first = await claimPoolVms(db, 'lab', [vm(), vm(10001)]);
  assert.deepEqual(first.waiting, ['vm-10001']);
  assert.equal(first.vms[0].vmid, 900000);
  db.entries.push(entry(900001));
  // Simulate restart with the original payload, before BullMQ data was saved.
  const second = await claimPoolVms(db, 'lab', [vm(), vm(10001)]);
  assert.deepEqual(second.waiting, []);
  assert.deepEqual(second.vms.map(row => row.vmid), [900000, 900001]);
  const third = await claimPoolVms(db, 'lab', second.vms);
  assert.deepEqual(third.vms, second.vms);
});

test('a claimed VM cannot be handed to a second lab', async () => {
  const entries = [entry()];
  await claimPoolVms(claimDatabase({ entries }), 'lab1', [vm()]);
  const result = await claimPoolVms(claimDatabase({ entries }), 'lab2', [vm()]);
  assert.equal(result.waiting.length, 1);
});

test('models without pools and existing lab VMs do not reserve pool VMs', async () => {
  const db = claimDatabase({ enabled: false, entries: [entry()] });
  assert.deepEqual((await claimPoolVms(db, 'lab', [vm()])).waiting, []);
  assert.equal(db.entries[0].status, 'ready');
  const enabledDb = claimDatabase({ entries: [entry()] });
  await claimPoolVms(enabledDb, 'lab', [vm()], new Set([10000]));
  assert.equal(enabledDb.entries[0].status, 'ready');
});

test('changed source or clone mode cannot consume stale inventory', async () => {
  const db = claimDatabase({ entries: [entry()] });
  assert.equal((await claimPoolVms(db, 'lab', [{ ...vm(), cloneSource: '9001' }])).waiting.length, 1);
  assert.equal((await claimPoolVms(db, 'lab', [{ ...vm(), fullClone: false }])).waiting.length, 1);
});

test('all lifecycle plans preserve assigned VM IDs and nodes without mutating the blueprint', () => {
  const original = [vm(), vm(10001)];
  const plan = applyPoolAssignments(original, { 10000: { vmid: 900000, node: 'pve' } });
  assert.equal(plan[0].poolNode, 'pve');
  assert.equal(plan[0].vmid, 900000);
  assert.equal(plan[1].vmid, 10001);
  assert.equal(original[0].vmid, 10000);
});

function reconciliation(entries, { enabled = true, size = 2, failure = false, prepared = false, osType = 'ubuntu' } = {}) {
  const events = [];
  const db = { async query(sql, args) {
    if (sql.startsWith('SELECT * FROM vm_templates')) return { rows: [{ id: 'model', pool_enabled: enabled, pool_size: size, proxmox_template_vmid: 9000, full_clone: true, os_type: osType }] };
    if (sql.startsWith('SELECT * FROM vm_pool')) return { rows: entries.filter(row => row.status !== 'assigned') };
    events.push([sql, args]);
    return { rows: [] };
  } };
  const api = {
    finish: async row => { events.push(['finish', row.vmid]); if (failure) throw new Error('clone running'); },
    prepare: async row => { events.push(['prepare', row.vmid]); return prepared; },
    exists: async () => true,
    remove: async row => events.push(['remove', row.vmid]),
    create: async () => events.push(['create'])
  };
  return { db, api, events };
}

test('background replenishment replaces consumed VMs, excluding assigned inventory', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'assigned'), entry(900001)]);
  await reconcileVmPools(db, api);
  assert.equal(events.filter(([event]) => event === 'create').length, 1);
  assert(!events.some(([event]) => event === 'remove'));
});

test('disabling a pool removes only unused VMs', async () => {
  const { db, api, events } = reconciliation([entry(), entry(900001, 'assigned')], { enabled: false });
  await reconcileVmPools(db, api);
  assert.deepEqual(events.filter(([event]) => event === 'remove'), [['remove', 900000]]);
  assert(!events.some(([event]) => event === 'create'));
});

test('reducing a pool and changing a model purge excess or stale inventory', async () => {
  const { db, api, events } = reconciliation([entry(), entry(900001), { ...entry(900002), source_vmid: 8000 }], { size: 1 });
  await reconcileVmPools(db, api);
  assert.deepEqual(events.filter(([event]) => event === 'remove').map(([, id]) => id), [900001, 900002]);
});

test('interrupted creation is reconciled before becoming available', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'creating')], { size: 1 });
  await reconcileVmPools(db, api);
  assert.equal(events[0][0], 'finish');
  assert.match(events[1][0], /status = 'ready'/);
  assert(!events.some(([event]) => event === 'create'));
});

test('uncertain clone operations are retained and errors are exposed without overfilling', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'creating')], { size: 1, failure: true });
  await reconcileVmPools(db, api);
  assert(events.some(([event]) => event.startsWith('UPDATE vm_pool SET error')));
  assert(!events.some(([event]) => ['create', 'remove'].includes(event)));
});

test('model validation rejects enabled zero-capacity pools, fractions and excessive sizes', () => {
  const source = readFileSync('dashboard/server.js', 'utf8');
  const code = source.slice(source.indexOf('const templateSchema ='), source.indexOf('const blueprintVmSchema ='));
  const context = { z };
  vmModule.runInNewContext(`${code}\nthis.schema = templateSchema;`, context);
  const base = { name: 'Ubuntu', osType: 'ubuntu', proxmoxTemplateVmid: 9000, poolEnabled: true };
  for (const poolSize of [0, -1, 1.5, 1001]) {
    assert.equal(context.schema.safeParse({ ...base, poolSize }).success, false);
  }
  assert.equal(context.schema.safeParse({ ...base, poolSize: 5 }).success, true);
  assert.equal(context.schema.safeParse({ ...base, poolEnabled: false, poolSize: 0 }).success, true);
});

function proxmoxPoolApi({ name = 'labfactory-pool-900000', status = 'stopped', locked = false, taskStatus = 'stopped', description = 'LabFactory pool owned-token', environment = 'production', guestResult = { exited: true, exitcode: 0 } } = {}) {
  const source = readFileSync('workers/terraformWorker.js', 'utf8');
  const code = source.slice(source.indexOf('function poolApi('), source.indexOf('export function startTerraformWorker'));
  const requests = [];
  const queries = [];
  const resources = [
    { vmid: 900000, name, status, node: 'pve', template: 0 },
    { vmid: 9000, name: 'source', status: 'stopped', node: 'pve', template: 1 }
  ];
  const context = {
    URL,
    windowsPoolOs, windowsPoolProbe, windowsPoolLabSettings, powershellCommand,
    WINDOWS_WINRM_WAIT_TIMEOUT_MS: 7200000,
    proxmoxInventoryPool: () => proxmoxInventoryPool(environment),
    requestJson: async request => {
      requests.push(request);
      if (request.url.pathname.endsWith('/clone')) {
        resources.push({ vmid: request.body.newid, name: request.body.name, status: 'stopped', node: 'pve', template: 0 });
      }
      if (request.url.pathname.endsWith('/exec')) return { data: { pid: 42 } };
      if (request.url.pathname.endsWith('/exec-status')) return { data: guestResult };
      return { data: 'task' };
    },
    proxmoxRequestOptions: () => ({}),
    fetchProxmoxVmResources: async () => resources,
    isProxmoxTemplate: value => value === 1,
    fetchVmCurrentStatus: async () => ({ status }),
    fetchVmConfig: async (_settings, _node, vmid) => ({
      name: vmid === 900000 ? name : `labfactory-pool-${vmid}`,
      description,
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,link_down=0',
      ipconfig0: 'ip=10.0.0.2/24', cipassword: 'secret', ciuser: 'ubuntu',
      onboot: 1, ...(locked ? { lock: 'clone' } : {})
    }),
    waitForProxmoxTask: async () => {},
    fetchProxmoxTaskStatus: async () => ({ status: taskStatus }),
    dbPool: { query: async sql => {
      queries.push(sql);
      return { rows: sql.includes('nextval') ? [{ vmid: 900001 }] : sql.includes('INSERT INTO vm_pool') ? [entry(900001, 'creating')] : [] };
    } }
  };
  vmModule.runInNewContext(`${code}\nthis.api = poolApi({ proxmox_api_url: 'https://pve/api2/json' }, { assertHeld() {} });`, context);
  return { api: context.api, requests, queries, resources, context };
}

test('stale cluster name and power state do not reject a verified node configuration', async () => {
  const { api, resources } = proxmoxPoolApi();
  resources[0].name = 'source';
  resources[0].status = 'unknown';
  resources[0].template = 1;
  assert.equal(await api.exists(entry()), true);
});

test('direct node checks still reject renamed VMs, templates and unexpected running guests', async () => {
  for (const change of ['name', 'template', 'status']) {
    const { api, context, requests } = proxmoxPoolApi();
    if (change === 'status') context.fetchVmCurrentStatus = async () => ({ status: 'running' });
    else {
      const original = context.fetchVmConfig;
      context.fetchVmConfig = async (...args) => ({ ...await original(...args), [change]: change === 'name' ? 'other' : 1 });
    }
    await assert.rejects(api.exists(entry()), change === 'status' ? /current status: running/ : /changed externally:/);
    assert.equal(requests.length, 0);
  }
});

test('a successful inventory recheck clears the previous error so the VM can be claimed', async () => {
  const { db, api, events } = reconciliation([{ ...entry(), error: 'temporary inventory mismatch' }], { size: 1 });
  await reconcileVmPools(db, api);
  assert(events.some(([sql]) => sql === 'UPDATE vm_pool SET error = NULL WHERE vmid = $1'));
  assert(!events.some(([event]) => event === 'remove' || event === 'create'));
});

test('clone requests place inventory directly into the environment-specific Proxmox pool', async () => {
  for (const environment of ['development', 'production']) {
    const { api, requests } = proxmoxPoolApi({ environment });
    await api.create({ id: 'model', proxmox_template_vmid: 9000, full_clone: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].body.pool, environment === 'development' ? 'pool-dev' : 'pool');
    assert.equal(requests[0].body.description, 'LabFactory pool owned-token');
    assert.equal(requests[1].method, 'PUT');
  }
});

test('non-Windows pool preparation disconnects networking, clears guest settings and keeps the VM off', async () => {
  const { api, requests } = proxmoxPoolApi();
  await api.finish({ ...entry(), task_id: 'clone-task' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.match(requests[0].url.pathname, /\/config$/);
  assert.equal(requests[0].body.onboot, 0);
  assert.match(requests[0].body.net0, /link_down=1$/);
  assert.deepEqual(requests[0].body.delete.split(',').sort(), ['cipassword', 'ciuser', 'ipconfig0']);
});

test('Windows clones enter the durable preparing phase and boot only after network isolation and cloud-init regeneration', async () => {
  const { api, requests, queries } = proxmoxPoolApi();
  const ready = await api.finish({ ...entry(), task_id: 'clone-task' }, { os_type: 'windows11' });
  assert.equal(ready, false);
  assert.deepEqual(requests.map(request => request.url.pathname.split('/').at(-1)), ['config', 'cloudinit', 'start']);
  assert.match(requests[0].body.net0, /link_down=1$/);
  assert(queries.some(sql => sql.includes("status = 'preparing'")));
  assert(!queries.some(sql => sql.includes("status = 'ready'")));
});

test('Windows preparation probes use QGA without networking and survive a worker restart with a stored PID', async () => {
  const first = proxmoxPoolApi({ status: 'running' });
  const preparing = { ...entry(900000, 'preparing'), preparation_started_at: new Date().toISOString() };
  assert.equal(await first.api.prepare(preparing), false);
  assert.match(first.requests[0].url.pathname, /\/agent\/exec$/);
  assert(first.queries.some(sql => sql.includes('guest_probe_pid = $2')));
  const resumed = proxmoxPoolApi({ status: 'running' });
  assert.equal(await resumed.api.prepare({ ...preparing, guest_probe_pid: 42 }), true);
  assert.equal(resumed.requests.length, 1);
  assert.match(resumed.requests[0].url.search, /pid=42/);
});

test('Windows pool readiness only waits for a fresh completion flag', () => {
  const row = entry();
  const script = windowsPoolProbe(row);
  assert.match(script, /done\.flag/);
  assert.match(script, /LastWriteTimeUtc/);
  assert(script.includes(new Date(row.created_at).toISOString()));
  assert.match(script, /exit 11/);
  assert.match(script, /labfactory-pool-ready\.flag/);
  assert.doesNotMatch(script, /Get-ItemProperty|Get-Process|Get-Service|Set-Service|IMAGE_STATE_COMPLETE|OOBE/);
});

test('a missing or stale completion flag or a running probe never makes inventory ready', async () => {
  for (const guestResult of [{ exited: false }, { exited: true, exitcode: 11 }, { exited: true, exitcode: 12 }, { exited: true, exitcode: 1 }]) {
    const { api } = proxmoxPoolApi({ status: 'running', guestResult });
    const pending = api.prepare({ ...entry(), preparation_started_at: new Date().toISOString(), guest_probe_pid: 42 });
    if (guestResult.exited) await assert.rejects(pending, /done.flag|script failed/);
    else assert.equal(await pending, false);
  }
  const { db, api, events } = reconciliation([entry(900000, 'preparing')], { size: 1 });
  await reconcileVmPools(db, api);
  assert(!events.some(([event]) => event.includes("status = 'ready'") || event === 'create'));
});

test('successful Windows preparation is persisted before the VM can be claimed', async () => {
  const { db, api, events } = reconciliation([entry(900000, 'preparing')], { size: 1, prepared: true });
  await reconcileVmPools(db, api);
  assert(events.some(([event]) => event.includes("status = 'ready', prepared_at = NOW()")));
  const claimed = await claimPoolVms(claimDatabase({ entries: [{ ...entry(), prepared_at: new Date() }] }), 'lab', [vm()]);
  assert.equal(claimed.vms[0].poolPrepared, true);
  assert.equal(claimed.vms[0].poolToken, 'owned-token');
});

test('old cold Windows inventory is sent through preparation instead of being treated as ready', async () => {
  const { db, api, events } = reconciliation([entry()], { size: 1, osType: 'windows11' });
  await reconcileVmPools(db, api);
  assert(events.some(([event]) => event.includes("status = 'preparing'")));
  assert(!events.some(([event]) => event === 'remove' || event === 'create'));
});

test('Windows preparation timeout is explicit and does not report success', async () => {
  const overdue = { ...entry(), preparation_started_at: new Date(Date.now() - 7200001), guest_probe_pid: 42 };
  const { api } = proxmoxPoolApi({ status: 'running', guestResult: { exited: true, exitcode: 11 } });
  await assert.rejects(api.prepare(overdue), /timed out.*done.flag missing/);
  const repaired = proxmoxPoolApi({ status: 'running' });
  assert.equal(await repaired.api.prepare(overdue), true, 'repair after the deadline can recover');
});

test('expired and legacy probes reset their PID instead of blocking preparation forever', async () => {
  for (const started of [null, new Date(Date.now() - 120001)]) {
    const { api, queries, requests } = proxmoxPoolApi({ status: 'running' });
    await assert.rejects(api.prepare({ ...entry(), guest_probe_pid: 42, guest_probe_started_at: started }), /probe expired/);
    assert(queries.some(sql => sql.includes('guest_probe_pid = NULL')));
    assert.equal(requests.length, 0);
  }
});

test('agent startup is persisted as preparation information, not an error', async () => {
  const { api, context } = proxmoxPoolApi({ status: 'running' });
  context.requestJson = async () => { throw new Error('QEMU guest agent is not running'); };
  const f = reconciliation([entry(900000, 'preparing')], { size: 1 });
  f.api.prepare = api.prepare;
  await reconcileVmPools(f.db, f.api);
  assert(f.events.some(([sql, args]) => sql.includes('SET error = NULL, preparation_message = $2') && args[1].includes('Waiting for QEMU Guest Agent')));
});

test('missing flags stay preparing until the deadline, while script and permission failures are errors', async () => {
  for (const [code, overdue, waiting] of [[11, false, true], [12, false, true], [11, true, false], [1, false, false]]) {
    const f = reconciliation([{ ...entry(900000, 'preparing'), guest_probe_pid: 42,
      preparation_started_at: new Date(Date.now() - (overdue ? 7200001 : 1000)) }], { size: 1 });
    f.api.prepare = proxmoxPoolApi({ status: 'running', guestResult: { exited: true, exitcode: code } }).api.prepare;
    await reconcileVmPools(f.db, f.api);
    assert(f.events.some(([sql]) => sql.includes(waiting ? 'SET error = NULL, preparation_message = $2' : 'SET error = $2, preparation_message = NULL')));
    assert(!f.events.some(([event]) => event === 'remove' || event === 'create'));
  }
  const f = reconciliation([entry(900000, 'preparing')], { size: 1 });
  const p = proxmoxPoolApi({ status: 'running' });
  p.context.requestJson = async () => { const error = new Error('Permission denied'); error.statusCode = 403; throw error; };
  f.api.prepare = p.api.prepare;
  await reconcileVmPools(f.db, f.api);
  assert(f.events.some(([sql]) => sql.includes('SET error = $2, preparation_message = NULL')));
});

test('every supplied Windows configuration enables the completion script directory', () => {
  for (const model of ['Win22', 'Win11fr']) {
    const config = readFileSync(`FilesForTemplates/${model}/cloudbase-init.conf`, 'utf8');
    assert.match(config, /cloudbaseinit.plugins.common.localscripts.LocalScriptsPlugin/);
    assert.match(config, /^local_scripts_path=C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\LocalScripts\\?\s*$/m);
    assert.match(readFileSync(`FilesForTemplates/${model}/99-finish.ps1`, 'utf8'), /done\.flag/);
  }
});

test('prepared running Windows inventory can be retained and is stopped before removal', async () => {
  const { api, requests } = proxmoxPoolApi({ status: 'running' });
  const prepared = { ...entry(), prepared_at: new Date(), preparation_started_at: new Date(), task_id: 'clone-task' };
  assert.equal(await api.exists(prepared), true);
  await api.remove(prepared);
  assert.deepEqual(requests.map(request => request.method), ['POST', 'DELETE']);
  assert.match(requests[0].url.pathname, /\/status\/stop$/);
});

test('cleanup refuses externally renamed, running, locked or still-cloning VMs', async () => {
  for (const options of [{ name: 'unrelated' }, { status: 'running' }, { locked: true }, { taskStatus: 'running' }, { description: 'other environment VM' }]) {
    const { api, requests } = proxmoxPoolApi(options);
    await assert.rejects(api.remove({ ...entry(), task_id: 'clone-task' }));
    assert.equal(requests.length, 0);
  }
});

test('cleanup deletes only an identified stopped pool VM after its clone task ends', async () => {
  const { api, requests } = proxmoxPoolApi();
  await api.remove({ ...entry(), task_id: 'clone-task' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.match(requests[0].url.pathname, /\/pve\/qemu\/900000$/);
  assert.equal(requests[0].url.search, '?purge=1');
  assert.equal(requests[0].body, undefined, 'Proxmox rejects a body on DELETE');
});

test('lab assignment configures a prepared Windows guest through QGA and redacts failed guest output', async () => {
  const source = readFileSync('workers/terraformWorker.js', 'utf8');
  const code = source.slice(source.indexOf('async function configurePreparedWindows('), source.indexOf('export function startTerraformWorker'));
  for (const exitcode of [0, 1, 21]) {
    const requests = [];
    const context = {
      URL, Date, powershellCommand, windowsPoolLabSettings, poolLabNetwork,
      sleep: async () => {}, proxmoxRequestOptions: () => ({}),
      fetchVmConfig: async () => ({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,link_down=1' }),
      fetchProxmoxVmResources: async () => [{ vmid: 900000, status: 'stopped' }],
      requestJson: async request => {
        requests.push(request);
        return { data: request.url.pathname.endsWith('/exec') ? { pid: 5 } : { exited: true, exitcode, 'err-data': 'sensitive-password' } };
      }
    };
    vmModule.runInNewContext(`${code}\nthis.configure = configurePreparedWindows;`, context);
    const call = context.configure(
      { proxmox_api_url: 'https://pve/api2/json', windows_admin_password: 'sensitive-password' },
      { vmid: 900000, poolNode: 'pve', poolToken: 'unique-token', windowsAdminUsername: 'Administrateur' },
      { ipconfig0: 'ip=10.0.1.2/24,gw=10.0.1.1' },
      { assertHeld() {} }, new AbortController().signal
    );
    if (exitcode === 0) await call;
    else await assert.rejects(call, error => /Guest configuration failed/.test(error.message)
      && !error.message.includes('sensitive-password')
      && (exitcode !== 21 || error.message.includes('lab network link did not become available')));
    assert.match(requests[0].url.pathname, /\/config$/);
    assert.equal(requests[0].method, 'PUT');
    assert.match(requests[0].body.net0, /bridge=vmbr0,firewall=0,link_down=0$/);
    assert.match(requests[1].url.pathname, /\/status\/start$/);
    assert.match(requests[2].url.pathname, /\/agent\/exec$/);
    const script = Buffer.from(requests[2].body.command.at(-1), 'base64').toString('utf16le');
    assert.match(script, /unique-token/);
    assert.match(script, /10\.0\.1\.2/);
    assert.match(script, /AA:BB:CC:DD:EE:FF/);
    assert(script.indexOf("Status -eq 'Up'") < script.indexOf('Set-NetIPInterface'), 'wait for link before applying the static IP');
  }
});

test('pool adoption connects directly to the lab network while preserving the MAC', () => {
  const original = 'virtio=AA:BB:CC:DD:EE:FF,bridge=old,tag=10,trunks=20;30,firewall=1,link_down=1';
  assert.equal(poolLabNetwork(original, { network_bridge: 'lan', network_firewall: true }, { vlan_tag: 250 }),
    'virtio=AA:BB:CC:DD:EE:FF,bridge=lan,firewall=1,tag=250,link_down=0');
  assert.equal(poolLabNetwork(original, { network_bridge: 'lan' }, { vlan_tag: 0 }),
    'virtio=AA:BB:CC:DD:EE:FF,bridge=lan,firewall=0,link_down=0');
  assert.throws(() => poolLabNetwork(original, { network_bridge: 'lan,tag=1' }, {}));
  assert.throws(() => poolLabNetwork(original, {}, { vlan_tag: 4095 }));
});
