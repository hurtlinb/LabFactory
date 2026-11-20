// Default Windows-pool VMID range (migration 032); used when the setting cannot be read.
export const DEFAULT_WINDOWS_POOL_VMID_RANGE = Object.freeze({ name: 'Windows pool', min: 70000, max: 79999 });

// Reads the pool range from the database. Falls back to the default only when the table
// does not exist yet (migration 032 not applied); any other error blocks (fail closed).
export async function readWindowsPoolVmidRange(db) {
  try {
    const row = (await db.query('SELECT vmid_min, vmid_max FROM windows_pool_settings WHERE id')).rows[0];
    return row ? { name: 'Windows pool', min: Number(row.vmid_min), max: Number(row.vmid_max) } : DEFAULT_WINDOWS_POOL_VMID_RANGE;
  } catch (error) {
    if (error?.code === '42P01') return DEFAULT_WINDOWS_POOL_VMID_RANGE;
    throw new Error(`Unable to read the Windows pool VMID range; creation blocked: ${error.message}`, { cause: error });
  }
}

// Check only resources Terraform is about to create; existing managed VMs may
// legitimately remain in Proxmox during an update or a destroy-before-create.
// reservedRanges: VMID ranges owned by another manager (Windows pool); Terraform never creates there.
export async function checkPlannedVmids(plan, fetchInventory, checkFreeVmid, reservedRanges = []) {
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
  for (const range of reservedRanges) {
    const inside = [...ids].filter(id => id >= range.min && id <= range.max);
    if (inside.length) {
      throw new Error(`VMID ${inside.join(', ')} reserved for the ${range.name} (${range.min}-${range.max}); Terraform creation blocked`);
    }
  }
  const inventory = await fetchInventory();
  if (!Array.isArray(inventory)) throw new Error('Unable to verify VMIDs: invalid Proxmox inventory');
  const conflicts = [];
  const freeIds = [];
  for (const resource of creations) {
    const { after, before, actions } = resource.change;
    const id = Number(after.vmid);
    if (!inventory.some(vm => Number(vm.vmid) === id)) freeIds.push(id);
    for (const existing of inventory.filter(vm => Number(vm.vmid) === id)) {
      const ownedReplacement = actions[0] === 'delete' && Number(before?.vmid) === id &&
        existing.type === 'qemu' && before?.id === `${existing.node}/qemu/${id}`;
      if (!ownedReplacement) conflicts.push(`${id} (${existing.name || 'unnamed'}, ${existing.node || 'unknown node'}, ${existing.type || 'VM'})`);
    }
  }
  if (conflicts.length) {
    throw new Error(`VMID conflict: ${conflicts.join('; ')} already in use in Proxmox. Creation blocked; allocate free VMIDs before retrying.`);
  }
  // Inventory is filtered by VM.Audit permissions. Absence there does not prove
  // availability; nextid checks the cluster-wide ID registry, including hidden guests.
  for (const id of freeIds) {
    try {
      if (typeof checkFreeVmid !== 'function') throw new Error('Proxmox availability check is required');
      const confirmed = await checkFreeVmid(id);
      if (!['number', 'string'].includes(typeof confirmed) || Number(confirmed) !== id) {
        throw new Error('Invalid Proxmox VMID availability response');
      }
    } catch (error) {
      throw new Error(`Unable to confirm VMID ${id} is free in Proxmox; creation blocked: ${error.message}`, { cause: error });
    }
  }
}
