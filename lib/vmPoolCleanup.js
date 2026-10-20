// Proxmox membership is authoritative, including inventory absent from our database.
export async function listVmPoolCleanup({ db, api, pool, protectedVmids }) {
  const pools = await api.pools();
  const members = pools.some(item => item.poolid === pool) ? await api.members(pool) : [];
  const { rows } = await db.query('SELECT * FROM vm_pool');
  const protectedIds = new Set(protectedVmids);
  rows.filter(row => row.deployment_id || row.status === 'assigned').forEach(row => protectedIds.add(Number(row.vmid)));
  const entries = [];
  for (const member of members.filter(item => item.type === 'qemu')) {
    const vmid = Number(member.vmid);
    const config = await api.config(member.node, vmid);
    const reason = protectedIds.has(vmid) ? 'Assigned to a lab'
      : Number(config.template) === 1 ? 'Source template'
      : config.lock ? `Locked: ${config.lock}` : null;
    entries.push({ kind: 'vm', vmid, node: member.node, name: config.name || member.name || String(vmid),
      digest: config.digest, reason });
  }
  const resources = await api.resources();
  const existing = new Set(resources.map(item => Number(item.vmid)));
  for (const row of rows) {
    if (protectedIds.has(Number(row.vmid)) || existing.has(Number(row.vmid))) continue;
    let reason = null;
    if (row.task_id) {
      try {
        if ((await api.task(row.node, row.task_id)).status !== 'stopped') reason = 'Proxmox task still running';
      } catch { reason = 'Unable to verify Proxmox task'; }
    } else if (row.status === 'creating') reason = 'Clone task unknown; manual review required';
    entries.push({ kind: 'record', vmid: Number(row.vmid), node: row.node, name: `Missing VM ${row.vmid}`,
      digest: row.ownership_token, reason });
  }
  return { pool, pools: pools.map(item => item.poolid), entries };
}

export async function emptyVmPool({ db, api, pool, protectedVmids, selected, assertHeld }) {
  const snapshot = await listVmPoolCleanup({ db, api, pool, protectedVmids });
  const deleted = [], skipped = [], errors = [];
  for (const requested of selected) {
    const entry = snapshot.entries.find(item => item.kind === requested.kind && item.vmid === requested.vmid);
    if (!entry || entry.reason || entry.node !== requested.node || entry.digest !== requested.digest || entry.name !== requested.name) {
      skipped.push({ vmid: requested.vmid, reason: entry?.reason || 'Inventory changed; refresh the preview' });
      continue;
    }
    try {
      assertHeld();
      if (entry.kind === 'vm') {
        const member = (await api.members(pool)).find(item => item.type === 'qemu' && Number(item.vmid) === entry.vmid && item.node === entry.node);
        if (!member) throw new Error('VM no longer belongs to the selected pool');
        const config = await api.config(entry.node, entry.vmid);
        if (!config.digest || config.digest !== entry.digest || config.lock || Number(config.template) === 1) {
          throw new Error('VM configuration changed; refresh the preview');
        }
        if ((await api.status(entry.node, entry.vmid)).status !== 'stopped') {
          assertHeld();
          await api.stop(entry.node, entry.vmid);
        }
        // Recheck after stopping: an external administrator may have moved the VM.
        if (!(await api.members(pool)).some(item => item.type === 'qemu' && Number(item.vmid) === entry.vmid && item.node === entry.node)) {
          throw new Error('VM left the selected pool while stopping');
        }
        const finalConfig = await api.config(entry.node, entry.vmid);
        if (finalConfig.digest !== entry.digest || finalConfig.lock || Number(finalConfig.template) === 1) {
          throw new Error('VM configuration changed while stopping');
        }
        assertHeld();
        await api.remove(entry.node, entry.vmid);
      } else if ((await api.resources()).some(item => Number(item.vmid) === entry.vmid)) {
        throw new Error('VM appeared since the preview; database record preserved');
      }
      assertHeld();
      await db.query("DELETE FROM vm_pool WHERE vmid = $1 AND deployment_id IS NULL AND status <> 'assigned'", [entry.vmid]);
      deleted.push({ vmid: entry.vmid, kind: entry.kind });
    } catch (error) {
      errors.push({ vmid: entry.vmid, reason: error.message });
    }
  }
  return { pool, deleted, skipped, errors };
}
