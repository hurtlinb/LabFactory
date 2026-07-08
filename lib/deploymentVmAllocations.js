export const mapDeploymentVmAllocation = row => ({
  deploymentId: row.deployment_id,
  logicalVmId: row.logical_vm_id,
  plannedVmid: Number(row.planned_vmid),
  actualVmid: Number(row.actual_vmid),
  templateId: row.template_id,
  source: row.source,
  poolInstanceId: row.pool_instance_id ?? null,
  runId: row.run_id ?? null,
  name: row.name ?? null,
  ipAddress: row.ip_address ?? null,
  node: row.node ?? null,
  status: row.status,
  createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
});

export const fetchDeploymentVmAllocations = async (dbPool, deploymentId) => {
  if (!deploymentId) {
    return [];
  }
  const result = await dbPool.query(
    `SELECT *
       FROM deployment_vm_allocations
      WHERE deployment_id = $1
        AND status = 'active'
      ORDER BY logical_vm_id ASC`,
    [deploymentId]
  );
  return result.rows.map(mapDeploymentVmAllocation);
};

export const applyDeploymentVmAllocations = (vmPlan, allocations) => {
  const allocationByLogicalId = new Map(
    (Array.isArray(allocations) ? allocations : []).map(allocation => [allocation.logicalVmId, allocation])
  );
  return {
    ...vmPlan,
    vms: (Array.isArray(vmPlan?.vms) ? vmPlan.vms : []).map(vm => {
      const allocation = allocationByLogicalId.get(vm.id);
      if (!allocation) {
        return {
          ...vm,
          plannedVmid: Number(vm.vmid),
          actualVmid: Number(vm.vmid),
          provisioningSource: 'terraform'
        };
      }
      return {
        ...vm,
        plannedVmid: allocation.plannedVmid,
        actualVmid: allocation.actualVmid,
        vmid: allocation.actualVmid,
        allocationSource: allocation.source,
        provisioningSource: allocation.source,
        poolInstanceId: allocation.poolInstanceId,
        allocationStatus: allocation.status
      };
    })
  };
};

export const upsertDeploymentVmAllocation = async (client, allocation) => {
  await client.query(
    `INSERT INTO deployment_vm_allocations
      (deployment_id, logical_vm_id, planned_vmid, actual_vmid, template_id, source,
       pool_instance_id, run_id, name, ip_address, node, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', NOW(), NOW())
     ON CONFLICT (deployment_id, logical_vm_id)
     DO UPDATE SET
       planned_vmid = EXCLUDED.planned_vmid,
       actual_vmid = EXCLUDED.actual_vmid,
       template_id = EXCLUDED.template_id,
       source = EXCLUDED.source,
       pool_instance_id = EXCLUDED.pool_instance_id,
       run_id = EXCLUDED.run_id,
       name = EXCLUDED.name,
       ip_address = EXCLUDED.ip_address,
       node = EXCLUDED.node,
       status = 'active',
       updated_at = NOW()`,
    [
      allocation.deploymentId,
      allocation.logicalVmId,
      allocation.plannedVmid,
      allocation.actualVmid,
      allocation.templateId,
      allocation.source,
      allocation.poolInstanceId ?? null,
      allocation.runId ?? null,
      allocation.name ?? null,
      allocation.ipAddress ?? null,
      allocation.node ?? null
    ]
  );
};
