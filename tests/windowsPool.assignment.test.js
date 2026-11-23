// Assignment of pool VMs to a lab (P4a): real PostgreSQL (isolated schema) + simulated Proxmox.
// Enabled by WINDOWS_POOL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPoolProxmox } from '../lib/windowsPool/proxmox.js';
import { createPoolManager } from '../lib/windowsPool/manager.js';
import { createPoolRequest, reservePoolRequest, cancelPoolRequest } from '../lib/windowsPool/reservation.js';
import { createPoolAssigner, SECOND_DISK_SERIAL } from '../lib/windowsPool/assignment.js';
import { fakeProxmox } from './helpers/windowsPoolFakeProxmox.js';

const url = process.env.WINDOWS_POOL_TEST_DATABASE_URL;
const quiet = { error() {}, warn() {}, info() {}, debug() {} };
const fast = { firstProbeDelayMs: 0, probeIntervalMs: 15, retryBackoffMs: [20, 40], cloneTimeoutMs: 5_000, powerTimeoutMs: 5_000 };
const assignFast = { leaseRetryMs: 10, connectSettleMs: 5, dhcpTimeoutMs: 2_000, winrmTimeoutMs: 300, winrmRetryMs: 20, rebootTimeoutMs: 5_000, guestRetryMs: 20 };

test('Windows pool assignment (P4a)', { skip: !url }, async t => {
  const { Pool } = await import('pg');
  const schema = 'wpool_asg_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 30 });
  try {
    await db.query(`CREATE TABLE vm_templates (id UUID PRIMARY KEY, language TEXT);
                    CREATE TABLE lab_deployments (id UUID PRIMARY KEY, last_job_id TEXT);`);
    await db.query(await fs.readFile(new URL('../db/migrations/032-windows-pool.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/035-windows-pool-replacements.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/036-windows-pool-simplified-activation.sql', import.meta.url), 'utf8')); await db.query(await fs.readFile(new URL('../db/migrations/037-windows-pool-global-placement.sql', import.meta.url), 'utf8'));
    // Stock in the pool's Proxmox pool ("pool-dev" in dev, "pool" in prod), labs in "labs-dev"/"labs".
    await db.query(`UPDATE windows_pool_settings SET paused = false, proxmox_pool = 'pool-dev'`);
    await db.query(`UPDATE windows_pool_operation_limits SET max_active = 2 WHERE category = 'assign'`);
    const templateId = randomUUID();
    await db.query(`INSERT INTO vm_templates VALUES ($1, 'en')`, [templateId]);
    await db.query(`INSERT INTO windows_pool_templates (template_id, enabled, ready_target, max_capacity, max_parallel_preparations, node, storage, source_template_vmid)
                    VALUES ($1, true, 0, 12, 6, 'pve-b', 'ceph-pool', 147)`, [templateId]);
    await db.query(`UPDATE windows_pool_settings SET node = 'pve-b', storage = 'ceph-pool', max_parallel_preparations = 6`); // global placement (migration 037)
    const px = fakeProxmox({ cloneMs: 30 });
    const proxmox = createPoolProxmox(px.request, { taskPollMs: 5, guestPollMs: 5 });
    const manager = createPoolManager({ db, proxmox, holder: 'asg', log: quiet, options: fast });
    const winrmCalls = [];
    let winrmDown = false;
    const winrmCheck = async target => { winrmCalls.push(target); if (winrmDown) throw new Error('connection refused'); };
    const assigner = createPoolAssigner({ db, proxmox, holder: 'asg', winrmCheck, log: quiet, options: assignFast });

    // Reserves `count` VMs for a new lab (replenishment driven by the demand).
    const reserveLab = async count => {
      const deploymentId = randomUUID();
      await db.query('INSERT INTO lab_deployments VALUES ($1, NULL)', [deploymentId]);
      const request = await createPoolRequest(db, { deploymentId, kind: 'deploy', demand: [{ templateId, count }] });
      for (let i = 0; i < 400; i++) {
        await manager.tick();
        const result = await reservePoolRequest(db, request.id);
        if (result.status === 'reserved' || result.status === 'unchanged') break;
        await sleep(20);
      }
      await manager.drain();
      const vms = (await db.query(`SELECT * FROM windows_pool_vms WHERE request_id = $1 ORDER BY vmid`, [request.id])).rows;
      assert.equal(vms.length, count);
      return { deploymentId, requestId: request.id, vms };
    };
    const slotFor = (lab, index, extra = {}) => ({
      requestId: lab.requestId, deploymentId: lab.deploymentId, workstationNumber: index + 1, blueprintVmId: randomUUID(),
      name: `IN101-AB-lab-${String(index + 1).padStart(2, '0')}-srv`, tags: ['ab'], vlanTag: 72 + index,
      network: { mode: 'static', ipAddress: `10.10.${72 + index}.10`, prefixLength: 25, gateway: `10.10.${72 + index}.1` },
      dnsServers: ['195.186.4.162', '195.186.4.163'], adminUser: 'Administrator', password: 'Final-Pa55word!', proxmoxPool: 'labs-dev', ...extra
    });
    const state = async id => (await db.query('SELECT state, error_code FROM windows_pool_vms WHERE id = $1', [id])).rows[0];

    await t.test('static assignment: network configured with the link down, then connection, WinRM, assignment recorded', async () => {
      const lab = await reserveLab(1);
      const vm = lab.vms[0];
      const slot = slotFor(lab, 0);
      const result = await assigner.assign(vm.id, slot);
      assert.equal(result.ipAddress, '10.10.72.10');
      assert.equal((await state(vm.id)).state, 'assigned');
      const g = px.guests.get(vm.vmid);
      assert.equal(g.config.name, slot.name);
      assert.equal(g.config.tags, 'labfactory-pool;ab');
      assert.match(g.config.net0, /tag=72,link_down=0$/);
      assert.match(g.config.description, new RegExp(`labfactory-pool:${vm.id}`), 'ownership marker kept');
      assert.deepEqual(g.net, { dhcp: 'Disabled', enableDhcp: 0, ip: '10.10.72.10', prefix: 25, gateway: '10.10.72.1', dns: ['195.186.4.162', '195.186.4.163'] });
      assert.equal(g.adminPassword, slot.password, 'final password applied');
      // Order: guest network (link down) -> connection -> post-connection check.
      const assignmentSteps = new Set(['pool-move', 'guest-network', 'wu-pause', 'connect', 'post-connect']);
      const events = px.stats.events.filter(e => e.vmid === vm.vmid && assignmentSteps.has(e.at)).map(e => `${e.at}${e.linkDown === undefined ? '' : e.linkDown ? ':down' : ':up'}`);
      assert.deepEqual(events, ['pool-move', 'guest-network:down', 'wu-pause:down', 'connect', 'post-connect:up'], 'leaves the stock pool before any network; Windows Update paused before connecting');
      const today = new Date().toISOString().slice(0, 10);
      assert.deepEqual(g.wuPause, { PauseQualityUpdatesStartTime: today }, 'Windows Server: quality updates paused (35 days)');
      assert.deepEqual(g.languageTasks.map(task => task.state), ['Disabled', 'Disabled', 'Disabled'], 'language components on demand disabled before connecting');
      assert.deepEqual(px.stats.events.filter(e => e.vmid === vm.vmid && e.at === 'pool-move').map(e => [e.from, e.to]), [['pool-dev', 'labs-dev']]);
      assert.equal(g.pool, 'labs-dev', 'assigned VM in the labs Proxmox pool');
      // The password never travels on the command line.
      assert.ok(px.stats.execBodies.every(body => !JSON.stringify(body.command).includes(slot.password)));
      assert.deepEqual(winrmCalls.at(-1), { ipAddress: '10.10.72.10', username: 'Administrator', password: slot.password, signal: undefined });
      const assignment = result.assignment;
      assert.deepEqual([assignment.manager, assignment.vmid, assignment.workstation_number, assignment.status], ['windows-pool', vm.vmid, 1, 'active']);
      const history = (await db.query('SELECT to_state FROM windows_pool_vm_events WHERE pool_vm_id = $1 ORDER BY id', [vm.id])).rows.map(r => r.to_state);
      assert.deepEqual(history, ['creating', 'preparing', 'ready', 'reserved', 'configuring', 'assigned']);
      const timings = (await db.query(`SELECT detail->'timings' AS t FROM windows_pool_vm_events WHERE pool_vm_id = $1 AND to_state = 'assigned'`, [vm.id])).rows[0].t;
      assert.deepEqual(Object.keys(timings).sort(), ['connectMs', 'guestNetworkMs', 'proxmoxMs', 'updatePauseMs', 'winrmMs'], 'duration of each step recorded');
      assert.equal(await assigner.warmUp(vm.vmid), true, 'warm-up: read-only QGA command');
      assert.equal(await assigner.warmUp(999999), false, 'warm-up never throws');
      // Idempotent: a second call (resume) does not redo anything.
      const again = await assigner.assign(vm.id, slot);
      assert.equal(again.resumed, true);
    });

    await t.test('resources and second disk: reboot with the network still disconnected, disk added once', async () => {
      const lab = await reserveLab(1);
      const vm = lab.vms[0];
      const slot = slotFor(lab, 0, { resources: { cores: 4, memory: 8192 }, secondDisk: { sizeGb: 20, storage: 'ceph-pool' } });
      await assigner.assign(vm.id, slot);
      const g = px.guests.get(vm.vmid);
      const reboot = g.history.find(h => h.at === 'reboot');
      assert.ok(reboot, 'reboot performed');
      assert.match(reboot.config.net0, /link_down=1/, 'reboot with the NIC disconnected');
      assert.equal(reboot.config.cores, 4);
      const disks = Object.entries(g.config).filter(([, v]) => String(v).includes(`serial=${SECOND_DISK_SERIAL}`));
      assert.equal(disks.length, 1);
      assert.match(disks[0][1], /^ceph-pool:20,/);
    });

    await t.test('DHCP mode: lease obtained after connecting', async () => {
      const lab = await reserveLab(1);
      const result = await assigner.assign(lab.vms[0].id, slotFor(lab, 0, { network: { mode: 'dhcp' }, dnsServers: [] }));
      assert.equal(result.ipAddress, '10.10.99.50');
      assert.equal(px.guests.get(lab.vms[0].vmid).net.dhcp, 'Enabled');
    });

    await t.test('IP conflict after connecting: quarantine and NIC disconnected again', async () => {
      const lab = await reserveLab(1);
      const vm = lab.vms[0];
      px.guests.get(vm.vmid).ipConflict = true;
      await assert.rejects(assigner.assign(vm.id, slotFor(lab, 0)), error => error.code === 'ASSIGNMENT_INVALID');
      assert.deepEqual(await state(vm.id), { state: 'quarantined', error_code: 'ASSIGNMENT_INVALID' });
      assert.match(px.guests.get(vm.vmid).config.net0, /link_down=1/);
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM lab_vm_assignments WHERE pool_vm_id = $1', [vm.id])).rows[0].n, 0);
    });

    await t.test('P0 defect (DHCP still enabled): detected before connecting, never connected', async () => {
      const lab = await reserveLab(1);
      const vm = lab.vms[0];
      px.guests.get(vm.vmid).dhcpDefect = true;
      await assert.rejects(assigner.assign(vm.id, slotFor(lab, 0)), error => error.code === 'ASSIGNMENT_INVALID' && /DHCP/.test(error.message));
      assert.ok(!px.stats.events.some(e => e.vmid === vm.vmid && e.at === 'connect'), 'never connected');
    });

    await t.test('Windows Update: feature updates paused too on Windows 11; unconfirmed pause = never connected', async () => {
      const lab = await reserveLab(2);
      await assigner.assign(lab.vms[0].id, slotFor(lab, 0, { osType: 'windows11' }));
      assert.deepEqual(Object.keys(px.guests.get(lab.vms[0].vmid).wuPause).sort(), ['PauseFeatureUpdatesStartTime', 'PauseQualityUpdatesStartTime']);
      const vm = lab.vms[1];
      px.guests.get(vm.vmid).wuPauseDefect = true;
      await assert.rejects(assigner.assign(vm.id, slotFor(lab, 1)), error => error.code === 'WU_PAUSE_FAILED');
      assert.ok(!px.stats.events.some(e => e.vmid === vm.vmid && e.at === 'connect'), 'never connected');
      assert.equal((await state(vm.id)).state, 'quarantined');
    });

    await t.test('language components on demand: a task left enabled = never connected', async () => {
      const lab = await reserveLab(1);
      const vm = lab.vms[0];
      px.guests.get(vm.vmid).languageTaskDefect = true;
      await assert.rejects(assigner.assign(vm.id, slotFor(lab, 0)), error => error.code === 'WU_PAUSE_FAILED' && /Installation=Ready/.test(error.message));
      assert.ok(!px.stats.events.some(e => e.vmid === vm.vmid && e.at === 'connect'), 'never connected');
      assert.equal((await state(vm.id)).state, 'quarantined');
    });

    await t.test('WinRM unavailable: quarantine', async () => {
      const lab = await reserveLab(1);
      winrmDown = true;
      try {
        await assert.rejects(assigner.assign(lab.vms[0].id, slotFor(lab, 0)), error => error.code === 'WINRM_FAILED');
      } finally { winrmDown = false; }
      assert.equal((await state(lab.vms[0].id)).state, 'quarantined');
    });

    await t.test('cancellation: request cancelled -> no connection; untouched VM stays intact', async () => {
      const lab = await reserveLab(2);
      await cancelPoolRequest(db, lab.requestId, { verifiedIntactIds: lab.vms.map(v => v.id) });
      await assert.rejects(assigner.assign(lab.vms[0].id, slotFor(lab, 0)), error => error.code === 'REQUEST_NOT_RESERVED');
      assert.equal((await state(lab.vms[0].id)).state, 'ready', 'released intact, not quarantined');
      assert.ok(!px.stats.events.some(e => e.vmid === lab.vms[0].vmid && e.at === 'connect'));
    });

    await t.test('lab of 3 VMs: chains in parallel, assign ceiling (2) never exceeded', async () => {
      const lab = await reserveLab(3);
      let maxLeases = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const n = (await db.query(`SELECT COUNT(*)::int AS n FROM windows_pool_operation_leases WHERE category = 'assign'`)).rows[0].n;
          maxLeases = Math.max(maxLeases, n);
          await sleep(2);
        }
      })();
      const started = Date.now();
      const results = await Promise.all(lab.vms.map((vm, i) => assigner.assign(vm.id, slotFor(lab, i))));
      sampling = false; await sampler;
      assert.equal(results.length, 3);
      // 2 'assign' leases held at the same time = 2 assignment chains in progress at the same time
      // (each chain holds its lease from the Proxmox configuration to WinRM): concurrency proven, ceiling respected.
      assert.equal(maxLeases, 2, 'two simultaneous chains, ceiling (2) never exceeded');
      assert.ok(Date.now() - started < 10_000);
      const slots = (await db.query('SELECT COUNT(*)::int AS n FROM lab_vm_assignments WHERE deployment_id = $1 AND status = \'active\'', [lab.deploymentId])).rows[0].n;
      assert.equal(slots, 3);
    });
  } finally {
    await db.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
