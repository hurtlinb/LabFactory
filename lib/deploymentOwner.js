// Apply metadata synchronously so an owner transfer cannot report success while
// Proxmox still has the previous name/tag. Keep unrelated tags intact.
export async function transferDeploymentMetadata({ request, resources, previousVms, nextVms, persist }) {
  const resourcesById = new Map(resources.map(resource => [Number(resource.vmid), resource]));
  const previousById = new Map(previousVms.map(vm => [Number(vm.vmid), vm]));
  const changes = [];
  for (const vm of nextVms) {
    const resource = resourcesById.get(Number(vm.vmid));
    if (!resource) continue;
    if (resource.type !== 'qemu' || !resource.node) throw new Error(`Unexpected VM resource for VMID ${vm.vmid}`);
    const path = `nodes/${encodeURIComponent(resource.node)}/qemu/${vm.vmid}/config`;
    const { data: config } = await request(path);
    const previous = previousById.get(Number(vm.vmid));
    if (!previous || ![previous.name, vm.name].includes(config.name)) {
      throw new Error(`VMID ${vm.vmid} has an unexpected name; verify that it belongs to this lab before changing its owner`);
    }
    if (config.lock) throw new Error(`VMID ${vm.vmid} is locked; retry after its operation finishes`);
    const tags = [...new Set([
      ...String(config.tags || '').split(';').filter(tag => tag && tag !== previous.tags),
      ...(vm.tags ? [vm.tags] : [])
    ])].join(';');
    if (config.name === vm.name && String(config.tags || '') === tags) continue;
    changes.push({ path, config, next: { name: vm.name, tags }, vmid: vm.vmid });
  }
  const attempted = [];
  try {
    for (const change of changes) {
      attempted.push(change);
      await request(change.path, { method: 'PUT', body: { ...change.next, digest: change.config.digest } });
    }
    await persist();
  } catch (error) {
    const failed = [];
    for (const change of attempted.reverse()) {
      try {
        const { data: current } = await request(change.path);
        if (current.name === change.config.name && String(current.tags || '') === String(change.config.tags || '')) continue;
        if (current.name !== change.next.name || String(current.tags || '') !== change.next.tags) throw new Error('Configuration changed concurrently');
        await request(change.path, { method: 'PUT', body: { name: change.config.name, tags: change.config.tags || '', digest: current.digest } });
      } catch { failed.push(change.vmid); }
    }
    if (failed.length) throw new Error(`${error.message}. Metadata restoration failed for VMIDs: ${failed.join(', ')}; verify their names and tags in Proxmox`);
    throw error;
  }
}
