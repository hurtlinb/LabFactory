// Runs under the deployment lock, after checking the durable lab reservation.
// Keep the ownership marker until Terraform imports the VM, so retries are safe.
export async function adoptPoolVm({ vm, resource, config, token, targetPool, inventoryPool, request, assertHeld }) {
  if (!token || config.description !== `LabFactory pool ${token}` || config.template === true || Number(config.template) === 1) {
    throw new Error(`Assigned pool VM ${vm.vmid} ownership does not match; refusing adoption`);
  }
  if (config.lock) throw new Error(`Assigned pool VM ${vm.vmid} is locked (${config.lock})`);
  const target = String(targetPool ?? '').trim();
  const current = resource.pool || '';
  if (current && current !== inventoryPool && current !== target) {
    throw new Error(`Assigned pool VM ${vm.vmid} belongs to unexpected pool ${current}`);
  }
  if (target === inventoryPool) throw new Error('The lab pool must differ from the inventory pool');
  if (!String(vm.name ?? '').trim()) throw new Error(`Assigned pool VM ${vm.vmid} has no lab name`);
  if (current !== target) {
    assertHeld();
    if (target) {
      await request(`pools/${encodeURIComponent(target)}`, { vms: String(vm.vmid), 'allow-move': 1 });
    } else if (current) {
      await request(`pools/${encodeURIComponent(current)}`, { vms: String(vm.vmid), delete: 1 });
    }
  }
  if (config.name !== vm.name) {
    assertHeld();
    await request(`nodes/${encodeURIComponent(resource.node)}/qemu/${vm.vmid}/config`, {
      name: vm.name, ...(config.digest ? { digest: config.digest } : {})
    });
  }
}
