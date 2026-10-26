// Check only resources Terraform is about to create; existing managed VMs may
// legitimately remain in Proxmox during an update or a destroy-before-create.
export async function checkPlannedVmids(plan, fetchInventory) {
  if (!plan || typeof plan !== 'object' || !plan.format_version ||
      (plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes))) {
    throw new Error('Unable to verify VMIDs: invalid Terraform plan');
  }
  const creations = (plan.resource_changes ?? []).filter(resource =>
    resource.type === 'proxmox_vm_qemu' && resource.change?.actions?.includes('create'));
  if (!creations.length) return;
  const ids = new Set();
  for (const resource of creations) {
    const id = Number(resource.change.after?.vmid);
    if (!Number.isSafeInteger(id) || id < 100 || resource.change.after_unknown?.vmid) {
      throw new Error(`Unable to verify VMID for ${resource.address}: a known VMID is required`);
    }
    if (ids.has(id)) throw new Error(`Duplicate VMID ${id} in Terraform plan; creation blocked`);
    ids.add(id);
  }
  const inventory = await fetchInventory();
  if (!Array.isArray(inventory)) throw new Error('Unable to verify VMIDs: invalid Proxmox inventory');
  const conflicts = [];
  for (const resource of creations) {
    const { after, before, actions } = resource.change;
    const id = Number(after.vmid);
    for (const existing of inventory.filter(vm => Number(vm.vmid) === id)) {
      const ownedReplacement = actions[0] === 'delete' && Number(before?.vmid) === id &&
        existing.type === 'qemu' && before?.id === `${existing.node}/qemu/${id}`;
      if (!ownedReplacement) conflicts.push(`${id} (${existing.name || 'unnamed'}, ${existing.node || 'unknown node'}, ${existing.type || 'VM'})`);
    }
  }
  if (conflicts.length) {
    throw new Error(`VMID conflict: ${conflicts.join('; ')} already in use in Proxmox. Creation blocked; allocate free VMIDs before retrying.`);
  }
}
