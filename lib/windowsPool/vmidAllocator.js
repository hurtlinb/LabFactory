import { randomUUID } from 'node:crypto';

// VMID allocation for the pool, in its dedicated range (windows_pool_settings).
// 1. In-pool uniqueness: the windows_pool_vms_live_vmid unique index (concurrent INSERT -> 23505).
// 2. Cluster-wide uniqueness: cluster/nextid?vmid=N answers N only if the ID is free,
//    including guests invisible to the API account (the inventory is filtered by VM.Audit).
// 3. Residual race (manual creation between the check and the clone): the clone fails with
//    "already exists"; the manager must then never adopt or destroy that VM (ownership check
//    through the labfactory-pool:<id> marker in the description).

// Circular candidates after lastVmid, skipping the IDs already used by the pool or the labs.
export function* vmidCandidates({ min, max, lastVmid = null, usedVmids = new Set() }) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) throw new Error('Invalid VMID range');
  const size = max - min + 1;
  const start = Number.isInteger(lastVmid) && lastVmid >= min && lastVmid <= max ? lastVmid + 1 : min;
  for (let offset = 0; offset < size; offset += 1) {
    const vmid = min + ((start - min + offset) % size);
    if (!usedVmids.has(vmid)) yield vmid;
  }
}

export const ownershipMarker = poolVmId => `labfactory-pool:${poolVmId}`;

// Strict Proxmox-side check of a pool VMID, called at allocation time AND again right
// before the clone (P2). Three independent sources must all agree:
//  1. cluster/nextid?vmid=N answers N (cluster registry, including guests the API account cannot see);
//  2. no guest (qemu/lxc, template or not) with this VMID in cluster/resources;
//  3. no volume (orphan disk, cloud-init, TPM...) with this VMID on the target storage:
//     a leftover disk would make the clone fail or would be adopted by mistake.
// request(path) -> Proxmox `data`. Throws (fail closed) at the slightest doubt.
export function createProxmoxVmidCheck({ request, node, storage }) {
  if (typeof request !== 'function' || !node || !storage) throw new Error('Incomplete Proxmox VMID check');
  return async vmid => {
    const confirmed = await request(`cluster/nextid?vmid=${vmid}`);
    if (Number(confirmed) !== vmid) throw new Error(`VMID ${vmid} refused by the cluster registry`);
    const resources = await request('cluster/resources?type=vm');
    if (!Array.isArray(resources)) throw new Error('Invalid Proxmox inventory');
    const guest = resources.find(resource => Number(resource.vmid) === vmid);
    if (guest) throw new Error(`VMID ${vmid} already used by ${guest.name || guest.type} on ${guest.node}`);
    const volumes = await request(`nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`);
    if (!Array.isArray(volumes)) throw new Error('Invalid storage contents');
    const leftover = volumes.find(volume => Number(volume.vmid) === vmid ||
      new RegExp(`(^|[:/])(vm|base)-${vmid}-`).test(String(volume.volid)));
    if (leftover) throw new Error(`VMID ${vmid}: volume ${leftover.volid} present on ${storage}`);
    return vmid;
  };
}

// Returns the windows_pool_vms row inserted in the 'creating' state with its VMID.
// checkFreeVmid(vmid) -> must return vmid or throw; in production it is
// createProxmoxVmidCheck(...) (registry + inventory + volumes).
// Excluded on the database side: the VMIDs of living pool VMs and of active lab assignments
// (Windows pool and Terraform), plus the range check (dedicated range).
export async function allocatePoolVm(pool, { templateConfig, checkFreeVmid, maxAttempts = 20 }) {
  if (typeof checkFreeVmid !== 'function') throw new Error('Proxmox availability check required');
  const settings = (await pool.query('SELECT cluster, vmid_min, vmid_max FROM windows_pool_settings WHERE id')).rows[0];
  if (!settings) throw new Error('Pool settings missing');
  const used = new Set((await pool.query(
    `SELECT vmid FROM windows_pool_vms WHERE cluster = $1 AND state <> 'deleted'
     UNION SELECT vmid FROM lab_vm_assignments WHERE cluster = $1 AND status = 'active'`,
    [settings.cluster])).rows.map(row => Number(row.vmid)));
  const last = (await pool.query(
    'SELECT vmid FROM windows_pool_vms WHERE cluster = $1 ORDER BY created_at DESC, vmid DESC LIMIT 1',
    [settings.cluster])).rows[0]?.vmid ?? null;

  let attempts = 0;
  for (const vmid of vmidCandidates({ min: settings.vmid_min, max: settings.vmid_max, lastVmid: last, usedVmids: used })) {
    if (attempts++ >= maxAttempts) break;
    let confirmed;
    try { confirmed = await checkFreeVmid(vmid); } catch { continue; } // occupied or uncertain: next one
    if (Number(confirmed) !== vmid) continue;
    const id = randomUUID();
    try {
      const result = await pool.query(
        `WITH inserted AS (
           INSERT INTO windows_pool_vms (id, template_id, revision, source_template_vmid, cluster, node, vmid, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'creating') RETURNING *
         ), logged AS (
           INSERT INTO windows_pool_vm_events (pool_vm_id, from_state, to_state, detail)
           SELECT id, NULL, 'creating', jsonb_build_object('vmid', vmid) FROM inserted
         )
         SELECT * FROM inserted`,
        [id, templateConfig.templateId, templateConfig.revision, templateConfig.sourceTemplateVmid,
          settings.cluster, templateConfig.node, vmid]);
      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') continue; // taken concurrently by another worker
      throw error;
    }
  }
  throw Object.assign(new Error('No free VMID found in the pool range'), { code: 'VMID_EXHAUSTED' });
}
