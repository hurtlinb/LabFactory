import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('dashboard/server.js', 'utf8');
const start = source.indexOf('    const node = vmResource.node;', source.indexOf("'/api/lifecycle/deployments/:id/vms/:vmid/reset-ip'"));
const script = source.slice(start, source.indexOf('    let pid;', start));
export function resetCommand(targetIp, networkGateway, maskBits = 25, osType = 'windows-server') {
  return vm.runInNewContext(`${script}\ncommand`, {
    vmResource: { node: 'pve' }, targetVm: { osType }, targetIp,
    classroom: { networkGateway, networkVlanMask: `/${maskBits}` },
    parseVlanMaskBits: () => maskBits
  });
}

test('reset uses the VM subnet gateway for each workplace and /25 subnet', () => {
  for (const os of ['windows-server', 'linux']) {
    for (const [ip, gateway] of [['10.10.162.66', '10.10.162.1'], ['10.10.162.194', '10.10.162.129']]) {
      const command = resetCommand(ip, '10.10.161.1', 25, os).at(-1);
      assert(command.includes(gateway));
      assert(!command.includes('10.10.161.1'));
    }
  }
});

test('Windows reset explicitly disables DHCP, verifies static IP and reports failures', () => {
  const command = resetCommand('10.10.162.66', '10.10.161.1').at(-1);
  assert(command.indexOf('-Dhcp Disabled') < command.indexOf('New-NetIPAddress'));
  assert(command.includes("$ErrorActionPreference = 'Stop'"));
  assert(command.includes("$iface.Dhcp -ne 'Disabled' -or -not $address"));
  assert(command.includes('exit 1'));
  assert(!command.includes('SilentlyContinue'));
});
