export const labStatusLabels = {
  idle: 'Not deployed', queued: 'Queued', deploying: 'Creating VMs',
  customizing: 'Configuring VMs', deployed: 'Ready', running: 'Running',
  mixed: 'Partially running', starting: 'Starting', stopping: 'Stopping',
  stopped: 'Stopped', destroying: 'Deleting VMs', destroyed: 'VMs deleted', failed: 'Failed'
};

export function labStatusLabel(status) {
  return labStatusLabels[status] || status || 'Unknown';
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
