import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createCustomizationStore, retryConnectionOperation, mapConcurrent, commandFailure } from './customizationRecovery.js';

export async function runCustomization({ job, windowsTargets, linuxTargets, directory, inventoryPath, extraVars, ansibleDir, runCommand, reconnect, buildProbeInventory, probePlaybook, signal }) {
  const store = createCustomizationStore(job, [...linuxTargets, ...windowsTargets]);
  const varsPath = path.join(directory, 'vars.json');
  await fs.writeFile(varsPath, JSON.stringify(extraVars), { mode: 0o600 });
  const commonArgs = ['--inventory', inventoryPath, '--extra-vars', '@' + varsPath];
  const options = { cwd: ansibleDir, env: { ...process.env }, signal };
  const execute = (playbook, host, args = []) => runCommand('ansible-playbook', [path.join(ansibleDir, playbook), ...commonArgs, '--limit', host, ...args], options);
  const password = target => String(target.windowsAdminPassword ?? extraVars.windows_admin_password ?? '');
  const fail = async (target, error) => {
    signal?.throwIfAborted();
    await store.update(target.vmid, { status: 'failed', error: commandFailure(error) });
  };
  const step = async (target, name, playbook, args = [], retry = true) => {
    if (store.records[target.vmid].completedSteps.includes(name)) return;
    const host = 'vm_' + (windowsTargets.indexOf(target) + 1);
    const run = () => execute(playbook, host, args);
    await store.update(target.vmid, { status: 'running', step: name, error: null, attempt: 0, lastResponse: null });
    if (retry) {
      await retryConnectionOperation({
        run, signal,
        probe: async () => {
          const inventory = path.join(directory, 'probe-' + target.vmid + '.yml');
          const playbookPath = path.join(directory, 'ping-' + target.vmid + '.yml');
          await fs.writeFile(inventory, buildProbeInventory(target, password(target)), { mode: 0o600 });
          await fs.writeFile(playbookPath, probePlaybook);
          try {
            await runCommand('timeout', ['45s', 'ansible-playbook', '-i', inventory, playbookPath], options);
          } catch (error) {
            if (error.code === 124) throw new Error('WinRM connection timed out after 45 seconds');
            throw error;
          }
        },
        report: patch => store.update(target.vmid, patch)
      });
    } else await run();
    await store.update(target.vmid, { error: null, lastResponse: 'Operation completed' }, name);
  };

  await mapConcurrent(linuxTargets, 5, async target => {
    if (store.records[target.vmid].status === 'succeeded') return;
    try {
      await store.update(target.vmid, { status: 'running', step: 'linux', error: null });
      await execute('linux-playbook.yml', 'linux_vm_' + (linuxTargets.indexOf(target) + 1));
      await store.update(target.vmid, { status: 'succeeded', error: null }, 'linux');
    } catch (error) { await fail(target, error); }
  });

  await mapConcurrent(windowsTargets, 5, async target => {
    if (store.records[target.vmid].status === 'succeeded') return;
    try {
      await store.update(target.vmid, { status: 'running', error: null });
      await step(target, 'setup', 'windows-playbook.yml', ['--tags', 'setup']);
      for (const [index, file] of target.stagedFileUploads.entries()) {
        const fileVars = path.join(directory, 'file-' + target.vmid + '-' + index + '.json');
        await fs.writeFile(fileVars, JSON.stringify({ file_uploads: [file] }), { mode: 0o600 });
        await step(target, 'copy: ' + file.destination, 'windows-playbook.yml', ['--tags', 'files', '--extra-vars', '@' + fileVars]);
      }
      await step(target, 'reboot', 'windows-playbook.yml', ['--tags', 'reboot'], false);
      if (!store.records[target.vmid].completedSteps.includes('reconnect')) {
        await store.update(target.vmid, { status: 'running', step: 'reconnect', error: null });
        await reconnect({ target, password: password(target), signal });
        await store.update(target.vmid, { error: null, lastResponse: 'WinRM responded' }, 'reconnect');
      }
      await store.update(target.vmid, { status: target.domainRole ? 'pending' : 'succeeded' });
    } catch (error) { await fail(target, error); }
  });

  // Domain controllers must finish before any members attempt to join.
  for (const role of ['controller', 'member']) {
    await mapConcurrent(windowsTargets.filter(target => target.domainRole === role), 5, async target => {
      if (['succeeded', 'failed'].includes(store.records[target.vmid].status)) return;
      try {
        await step(target, 'domain', 'windows-domain-playbook.yml', [], false);
        await store.update(target.vmid, { status: 'succeeded', error: null });
      } catch (error) { await fail(target, error); }
    });
  }
  const failed = Object.values(store.records).filter(record => record.status !== 'succeeded');
  if (failed.length) throw new Error(failed.map(record => `${record.name} (VM ${record.vmid}), ${record.step}, attempt ${record.attempt || 1}: ${record.error}`).join('; '));
}
