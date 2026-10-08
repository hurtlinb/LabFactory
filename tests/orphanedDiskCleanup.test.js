import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('dashboard/server.js', 'utf8');
const start = source.indexOf('const cleanOrphanedDisksOnProxmoxNode =');
const code = source.slice(start, source.indexOf('\n};', start) + 3);
const disk = id => ({ volid: `ceph-pool:vm-${id}-cloudinit`, vmid: id });
function setup(overrides = {}) {
  const deleted = [];
  const context = {
    readTerraformEnvSettings: () => ({ proxmox_nodes: 'a,b' }),
    assertRequiredTerraformEnvSettings: () => {},
    parseNodeList: value => value.split(','),
    ORPHANED_DISK_CLEANUP_POOL: 'ceph-pool',
    fetchClusterVmResources: async () => [],
    fetchQemuConfigs: async () => [],
    fetchProxmoxNodeNames: async () => ['a', 'b'],
    fetchStorageContent: async () => [disk(1)],
    isStorageImageVolume: () => true,
    getStorageVolumeName: volid => volid.split(':')[1],
    parseVmidFromVolume: volume => volume.vmid,
    deleteStorageVolume: async (_env, node, _pool, volid) => { deleted.push({ node, volid }); return volid; },
    waitForProxmoxTask: async () => {},
    ...overrides
  };
  vm.runInNewContext(`${code}\nthis.run = cleanOrphanedDisksOnProxmoxNode;`, context);
  return { run: context.run, deleted };
}

test('a shared Cloud-Init image is deleted only once', async () => {
  const { run, deleted } = setup();
  const result = await run();
  assert.equal(deleted.length, 1);
  assert.equal(result.deletedVolumes.length, 1);
  assert.equal(result.complete, true);
});

test('one failed inventory does not prevent cleanup via another node and is reported', async () => {
  const { run, deleted } = setup({ fetchStorageContent: async (_env, node) => {
    if (node === 'a') throw new Error('listing images failed');
    return [disk(1)];
  } });
  const result = await run();
  assert.equal(deleted[0].node, 'b');
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 1);
});

test('all failed inventories report incomplete, never successful empty cleanup', async () => {
  const { run, deleted } = setup({ fetchStorageContent: async () => { throw new Error('offline'); } });
  const result = await run();
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 2);
  assert.equal(deleted.length, 0);
});

test('existing VMIDs and referenced volumes remain protected', async () => {
  const { run, deleted } = setup({
    fetchClusterVmResources: async () => [{ vmid: 1 }],
    fetchQemuConfigs: async () => [{ config: { unused0: disk(2).volid } }],
    fetchStorageContent: async () => [disk(1), disk(2), disk(3)]
  });
  const result = await run();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].volid, disk(3).volid);
  assert.equal(result.skippedVolumes.length, 2);
});

test('missing images, watchers and other failures do not stop later volumes', async () => {
  const { run } = setup({
    fetchStorageContent: async () => [1, 2, 3, 4].map(disk),
    waitForProxmoxTask: async (_env, _node, volid) => {
      const messages = { 1: 'rbd: error opening image vm-1-cloudinit: (2) No such file or directory', 2: 'image still has watchers', 3: 'permission denied' };
      const id = /vm-(\d+)/.exec(volid)[1];
      if (messages[id]) throw Object.assign(new Error('task failed'), { exitStatus: messages[id] });
    }
  });
  const result = await run();
  assert.equal(result.absentVolumes.length, 1);
  assert.equal(result.skippedVolumes.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.deletedVolumes[0], disk(4).volid);
});

test('unreadable VM configurations abort before deleting anything', async () => {
  const { run, deleted } = setup({ fetchQemuConfigs: async () => { throw new Error('config denied'); } });
  await assert.rejects(run(), /config denied/);
  assert.equal(deleted.length, 0);
});
