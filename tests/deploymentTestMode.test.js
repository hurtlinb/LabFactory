import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync('dashboard/server.js', 'utf8');
const start = source.indexOf('const buildTerraformDeploymentPayload =');
const context = {
  computeBlueprintBaseVmid: () => 1000, sanitizeVmName: s => s,
  buildVmNamePrefix: () => 'lab', buildTeacherTag: () => '',
  resolveVmHostnameToken: (vm, fallback) => fallback, resolveVmCustomHostname: () => '',
  getWindowsAdminUsername: () => 'Administrator', isVmCustomNameEnabled: () => false,
  getFileUploads: () => [], getAnsibleTasks: () => []
};
vm.runInNewContext(source.slice(start, source.indexOf('\n};', start) + 3) + '\nthis.build = buildTerraformDeploymentPayload;', context);
test('test deployment contains every blueprint VM on the first workplace only', () => {
  const args = { deploymentId: 'lab', blueprint: { name: 'Demo', vms: [1,2].map(id => ({ id, template: { proxmoxTemplateVmid: 900 } })) }, classroom: { workstationCount: 22, startingSubnet: '10.0.200.0', startingVlan: 200 } };
  const full = context.build(args);
  const limited = context.build({ ...args, testMode: true });
  assert.equal(full.vms.length, 44);
  assert.equal(limited.vms.length, 2);
  assert.deepEqual(limited.vms, full.vms.slice(0,2));
  assert.ok(limited.vms.every(vm => vm.id.startsWith('01-') && vm.vlanTag === 200 && vm.subnetBase === '10.0.200.0'));
});
