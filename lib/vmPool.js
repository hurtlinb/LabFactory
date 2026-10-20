import { windowsPoolOs } from './windowsPool.js';

export const proxmoxInventoryPool = (environment = process.env.NODE_ENV) =>
  ['development', 'dev'].includes(String(environment ?? 'production').trim().toLowerCase()) ? 'pool-dev' : 'pool';

// Claims are durable before Terraform import; a retry always reuses the same VM.
export async function claimPoolVms(db, deploymentId, vms, existingVmids = new Set()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const deployment = await client.query('SELECT pool_assignments FROM lab_deployments WHERE id = $1 FOR UPDATE', [deploymentId]);
    if (!deployment.rows.length) throw new Error('Deployment not found while claiming pool VMs');
    const assignments = deployment.rows[0].pool_assignments || {};
    const waiting = [];
    for (const vm of vms) {
      if (assignments[vm.vmid] || Object.values(assignments).some(entry => entry.vmid === vm.vmid) || existingVmids.has(Number(vm.vmid))) continue;
      const model = await client.query('SELECT pool_enabled FROM vm_templates WHERE id = $1', [vm.templateId]);
      if (!model.rows[0]?.pool_enabled) continue;
      const result = await client.query(
        `SELECT p.* FROM vm_pool p JOIN vm_templates t ON t.id = p.template_id
         WHERE p.template_id = $1 AND p.status = 'ready' AND t.pool_enabled
           AND p.error IS NULL
           AND (t.os_type NOT IN ('windows11', 'windows-server') OR p.prepared_at IS NOT NULL)
           AND p.source_vmid = $2 AND p.full_clone = $3
           AND p.source_vmid = t.proxmox_template_vmid AND p.full_clone = t.full_clone
         ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
        [vm.templateId, Number(vm.cloneSource), Boolean(vm.fullClone)]
      );
      const entry = result.rows[0];
      if (!entry) { waiting.push(vm.id); continue; }
      await client.query("UPDATE vm_pool SET status = 'assigned', deployment_id = $2, original_vmid = $3 WHERE vmid = $1", [entry.vmid, deploymentId, vm.vmid]);
      assignments[vm.vmid] = { vmid: Number(entry.vmid), node: entry.node, prepared: Boolean(entry.prepared_at), token: entry.ownership_token };
    }
    await client.query('UPDATE lab_deployments SET pool_assignments = $2::jsonb WHERE id = $1', [deploymentId, JSON.stringify(assignments)]);
    await client.query('COMMIT');
    return { vms: applyPoolAssignments(vms, assignments), waiting };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function applyPoolAssignments(vms, assignments = {}) {
  return vms.map(vm => {
    const entry = assignments[vm.vmid] || Object.values(assignments).find(item => Number(item.vmid) === Number(vm.vmid));
    return entry ? { ...vm, vmid: Number(entry.vmid), poolNode: entry.node, poolPrepared: Boolean(entry.prepared), poolToken: entry.token } : vm;
  });
}

export async function clearPoolPreparationForReplacement(db, deploymentId, vmids) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT pool_assignments FROM lab_deployments WHERE id = $1 FOR UPDATE', [deploymentId]);
    const assignments = rows[0]?.pool_assignments ?? {};
    for (const entry of Object.values(assignments)) {
      if (vmids.includes(Number(entry.vmid))) entry.prepared = false;
    }
    await client.query('UPDATE lab_deployments SET pool_assignments = $2::jsonb WHERE id = $1', [deploymentId, JSON.stringify(assignments)]);
    await client.query('UPDATE vm_pool SET prepared_at = NULL WHERE deployment_id = $1 AND vmid = ANY($2::int[])', [deploymentId, vmids]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// Called under a cluster-wide advisory lock. Only unassigned VMs can be removed.
export async function reconcileVmPools(db, api) {
  const { rows: templates } = await db.query('SELECT * FROM vm_templates ORDER BY id');
  for (const template of templates) {
    const { rows } = await db.query("SELECT * FROM vm_pool WHERE template_id = $1 AND status <> 'assigned' ORDER BY created_at", [template.id]);
    const target = template.pool_enabled ? template.pool_size : 0;
    let retained = 0;
    for (const entry of rows) {
      try {
        const compatible = entry.source_vmid === template.proxmox_template_vmid && entry.full_clone === template.full_clone;
        if (entry.status === 'ready' && compatible && retained < target && windowsPoolOs(template.os_type) && !entry.prepared_at) {
          await db.query("UPDATE vm_pool SET status = 'preparing', preparation_started_at = NOW() WHERE vmid = $1", [entry.vmid]);
          retained++;
          continue;
        }
        if (entry.status === 'preparing' && compatible && retained < target) {
          if (await api.prepare(entry)) {
            await db.query("UPDATE vm_pool SET status = 'ready', prepared_at = NOW(), error = NULL, preparation_message = NULL, guest_probe_pid = NULL, guest_probe_started_at = NULL WHERE vmid = $1", [entry.vmid]);
          } else if (entry.error) {
            await db.query('UPDATE vm_pool SET error = NULL WHERE vmid = $1', [entry.vmid]);
          }
          retained++;
          continue;
        }
        if (entry.status === 'creating') {
          if (await api.finish(entry, template) === false) { retained++; continue; }
          await db.query("UPDATE vm_pool SET status = 'ready', error = NULL WHERE vmid = $1", [entry.vmid]);
          entry.status = 'ready';
        }
        const valid = entry.status === 'ready' && entry.source_vmid === template.proxmox_template_vmid && entry.full_clone === template.full_clone;
        if (valid && retained < target && await api.exists(entry)) {
          if (entry.error) await db.query('UPDATE vm_pool SET error = NULL WHERE vmid = $1', [entry.vmid]);
          retained++;
          continue;
        }
        await api.remove(entry);
        await db.query("DELETE FROM vm_pool WHERE vmid = $1 AND status <> 'assigned'", [entry.vmid]);
      } catch (error) {
        await db.query(error.poolWaiting
          ? 'UPDATE vm_pool SET error = NULL, preparation_message = $2 WHERE vmid = $1'
          : 'UPDATE vm_pool SET error = $2, preparation_message = NULL WHERE vmid = $1',
        [entry.vmid, String(error.message).slice(0, 2000)]);
        // Do not create replacements for uncertain or still-running clone operations.
        retained++;
      }
    }
    // One clone per model per pass keeps background work bounded.
    if (retained < target) await api.create(template);
  }
}
