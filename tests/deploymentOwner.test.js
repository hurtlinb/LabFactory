import test from 'node:test';
import assert from 'node:assert/strict';
import { transferDeploymentMetadata } from '../lib/deploymentOwner.js';

function fixture() {
  const configs = new Map([1, 2].map(id => [id, { name: `123-old-lab-${id}`, tags: 'old;keep', digest: 'v1' }]));
  const writes = [];
  let persisted = false;
  const args = {
    resources: [1, 2, 99].map(vmid => ({ vmid, node: 'node', type: 'qemu' })),
    previousVms: [1, 2, 3].map(vmid => ({ vmid, name: `123-old-lab-${vmid}`, tags: 'old' })),
    nextVms: [1, 2, 3].map(vmid => ({ vmid, name: `123-new-lab-${vmid}`, tags: 'new' })),
    request: async (path, options) => {
      const id = Number(path.split('/')[3]);
      const current = configs.get(id);
      if (options) {
        assert.equal(options.method, 'PUT');
        assert.equal(options.body.digest, current.digest);
        writes.push(id);
        configs.set(id, { ...options.body, digest: `v${writes.length + 1}` });
      }
      return { data: { ...configs.get(id) } };
    },
    persist: async () => { persisted = true; }
  };
  return { args, configs, writes, persisted: () => persisted };
}

test('owner transfer renames existing VMs and replaces only the owner tag before persisting', async () => {
  const f = fixture();
  await transferDeploymentMetadata(f.args);
  assert.deepEqual(f.writes, [1, 2]);
  assert.equal(f.configs.get(1).name, '123-new-lab-1');
  assert.equal(f.configs.get(1).tags, 'keep;new');
  assert(f.persisted());
});

test('VMID collision or locked VM prevents all metadata writes', async () => {
  for (const patch of [{ name: 'production-vm' }, { lock: 'snapshot' }]) {
    const f = fixture();
    Object.assign(f.configs.get(2), patch);
    await assert.rejects(transferDeploymentMetadata(f.args));
    assert.deepEqual(f.writes, []);
    assert.equal(f.persisted(), false);
  }
});

test('Proxmox or database failure restores already changed metadata', async () => {
  for (const failure of ['proxmox', 'database']) {
    const f = fixture();
    const request = f.args.request;
    f.args.request = async (path, options) => {
      if (failure === 'proxmox' && path.includes('/2/') && options) throw Error('write failed');
      return request(path, options);
    };
    if (failure === 'database') f.args.persist = async () => { throw Error('write failed'); };
    await assert.rejects(transferDeploymentMetadata(f.args), /write failed/);
    for (const id of [1, 2]) {
      assert.equal(f.configs.get(id).name, `123-old-lab-${id}`);
      assert.equal(f.configs.get(id).tags, 'old;keep');
    }
    assert.equal(f.persisted(), false);
  }
});

test('rollback failures identify VMs needing repair', async () => {
  const f = fixture();
  const request = f.args.request;
  f.args.request = async (path, options) => {
    if (options?.body.name.includes('-old-')) throw Error('unreachable');
    return request(path, options);
  };
  f.args.persist = async () => { throw Error('database failed'); };
  await assert.rejects(transferDeploymentMetadata(f.args), /restoration failed for VMIDs: 2, 1/);
});
