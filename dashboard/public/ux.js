export const labStatusLabels = {
  idle: 'Not deployed', queued: 'Queued', deploying: 'Creating VMs',
  customizing: 'Configuring VMs', deployed: 'Ready', running: 'Running',
  mixed: 'Partially started', starting: 'Starting', stopping: 'Stopping',
  stopped: 'Stopped', destroying: 'Deleting VMs', destroyed: 'VMs deleted', failed: 'Failed',
  waiting_for_pool: 'Waiting for the Windows pool'
};

export function labStatusLabel(status) {
  return labStatusLabels[status] || status || 'Unknown';
}

// Lab using the Windows pool: during the transfers, "Transferring from pool" (the VMs are
// taken already prepared, not created); "Creating VMs and transferring from pool" for a lab that
// also has Terraform VMs. deployment.poolProgress = { total, assigned, active }.
export function deploymentStatusLabel(deployment, totalVmCount = deployment?.totalVmCount) {
  const pool = deployment?.poolProgress;
  if (deployment?.status === 'deploying' && pool?.active && pool.total > 0) {
    return pool.total >= Number(totalVmCount || 0) ? 'Transferring from pool' : 'Creating VMs and transferring from pool';
  }
  return labStatusLabel(deployment?.status);
}

// Progress line of a busy lab card. A pool VM integrated in the lab counts as ready.
// The status itself is already shown by the card's status pill: it is not repeated here.
export function deploymentProgressText(deployment, totalVmCount, readyCount) {
  const pool = deployment?.poolProgress;
  const created = Number(deployment?.createdCount || 0);
  const started = Number(deployment?.startedCount || 0);
  if (pool?.total > 0) {
    const transferred = `Transferred from pool: ${Math.min(pool.assigned, pool.total)}/${pool.total}`;
    const terraform = pool.total < totalVmCount ? ` · Created: ${created}/${totalVmCount} · Started: ${started}/${totalVmCount}` : '';
    return `${transferred}${terraform} · Ready: ${readyCount}/${totalVmCount}`;
  }
  return `Created: ${created}/${totalVmCount} · Started: ${started}/${totalVmCount} · Ready: ${readyCount}/${totalVmCount}`;
}

export function blueprintFingerprint(blueprint) {
  const { name, description, courseId, windowsAdminPassword, guestPasswordMode, linuxDefaultUsername, vms } = blueprint;
  return JSON.stringify({ name, description, courseId, windowsAdminPassword, guestPasswordMode, linuxDefaultUsername, vms });
}

export function matchesSearch(query, ...values) {
  const text = values.flat(Infinity).filter(value => value != null).join(' ').toLocaleLowerCase();
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}

export function classroomPreview({ workstationCount, startingVlan, startingSubnet, networkGateway, networkVlanMask = '/24' }) {
  const count = Number(workstationCount);
  const parts = String(startingSubnet).split('.').map(Number);
  const gateway = String(networkGateway).split('.').map(Number);
  const vlan = Number(startingVlan);
  if (!Number.isInteger(count) || count < 1 || parts.length !== 4 || gateway.length !== 4 ||
      [...parts, ...gateway].some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
      parts[2] + count - 1 > 255 || !Number.isInteger(vlan) || vlan < 1 || vlan + count - 1 > 4094) return null;
  return [...new Set([0, count - 1])].map(index => ({
    workstation: index + 1, vlan: vlan + index,
    subnet: `${parts[0]}.${parts[1]}.${parts[2] + index}.${parts[3]}${networkVlanMask}`,
    gateway: `${parts[0]}.${parts[1]}.${parts[2] + index}.${gateway[3]}`
  }));
}
