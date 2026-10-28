export const SNAPSHOT_NAME = 'labfactory';

const fail = (statusCode, message) => {
  throw Object.assign(new Error(message), { statusCode });
};
const vmPath = resource => `nodes/${encodeURIComponent(resource.node)}/qemu/${Number(resource.vmid)}`;

export async function getVmSnapshot(request, resource) {
  const [snapshots, config] = await Promise.all([
    request(`${vmPath(resource)}/snapshot`),
    request(`${vmPath(resource)}/config`)
  ]);
  if (!Array.isArray(snapshots?.data)) throw new Error('Invalid snapshot response from Proxmox');
  const snapshot = snapshots.data.find(item => item.name === SNAPSHOT_NAME);
  return { exists: Boolean(snapshot), name: SNAPSHOT_NAME, createdAt: snapshot?.snaptime ?? null, locked: Boolean(config?.data?.lock) };
}

export async function startVmSnapshotAction(request, resource, action) {
  if (!['create', 'delete', 'restore'].includes(action)) fail(400, 'Invalid snapshot action');
  const snapshot = await getVmSnapshot(request, resource);
  if (snapshot.locked) fail(409, 'VM already has an operation in progress');
  if (action === 'create' && snapshot.exists) fail(409, 'Delete the existing labfactory snapshot before creating a new one');
  if (action !== 'create' && !snapshot.exists) fail(409, 'No labfactory snapshot exists for this VM');
  const path = `${vmPath(resource)}/snapshot`;
  const options = action === 'create'
    ? { method: 'POST', body: { snapname: SNAPSHOT_NAME, vmstate: 0 } }
    : action === 'delete'
      ? { method: 'DELETE' }
      : { method: 'POST', body: { start: resource.status === 'running' ? 1 : 0 } };
  const result = await request(action === 'create' ? path : `${path}/${SNAPSHOT_NAME}${action === 'restore' ? '/rollback' : ''}`, options);
  if (typeof result?.data !== 'string' || !result.data.startsWith('UPID:')) {
    throw new Error('Proxmox did not return a snapshot task ID; refresh before retrying');
  }
  return { task: result.data };
}

export async function getVmSnapshotTask(request, resource, task) {
  const parts = String(task).split(':');
  if (parts.length !== 9 || parts[0] !== 'UPID' || !parts[1] ||
      !['qmsnapshot', 'qmdelsnapshot', 'qmrollback'].includes(parts[5]) || parts[6] !== String(resource.vmid)) {
    fail(400, 'Invalid snapshot task');
  }
  const result = await request(`nodes/${encodeURIComponent(parts[1])}/tasks/${encodeURIComponent(task)}/status`);
  const status = result?.data;
  if (!['running', 'stopped'].includes(status?.status)) throw new Error('Invalid snapshot task status');
  return { complete: status.status === 'stopped', success: status.status === 'stopped' && status.exitstatus === 'OK', error: status.status === 'stopped' && status.exitstatus !== 'OK' ? status.exitstatus || 'Unknown snapshot task failure' : null };
}
