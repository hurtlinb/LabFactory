import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createCustomizationStore, retryConnectionOperation, mapConcurrent, commandFailure } from './customizationRecovery.js';
import { activeAnsibleTasks, taskCheckpoint } from './ansibleTasks.js';
import { runAnsibleTaskBlock } from './runAnsibleTasks.js';

export async function runCustomization({ job, windowsTargets, linuxTargets, directory, inventoryPath, extraVars, ansibleDir, runCommand, reconnect, buildProbeInventory, probePlaybook, signal, runTaskBlock = runAnsibleTaskBlock }) {
  const store = createCustomizationStore(job, [...linuxTargets, ...windowsTargets]);
  const targets = [...linuxTargets, ...windowsTargets];
  const blocks = new Map(targets.map(target => [target.vmid, activeAnsibleTasks(target)]));
  const finishedStatus = target => blocks.get(target.vmid).length ? 'pending' : 'succeeded';
  // Validate every enabled block in the actual execution image before changing any VM.
  for (const target of targets) {
    for (const block of blocks.get(target.vmid)) {
      try {
        await runTaskBlock({ block, target, syntaxOnly: true, signal });
      } catch (error) {
        await store.update(target.vmid, { status: 'failed', step: `Validate Ansible: ${block.name}`, error: commandFailure(error) });
        throw error;
      }
    }
  }
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
      if (!store.records[target.vmid].completedSteps.includes('linux')) {
        await execute('linux-playbook.yml', 'linux_vm_' + (linuxTargets.indexOf(target) + 1));
      }
      await store.update(target.vmid, { status: finishedStatus(target), error: null }, 'linux');
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
      await store.update(target.vmid, { status: target.domainRole ? 'pending' : finishedStatus(target) });
    } catch (error) { await fail(target, error); }
  });

  // Domain controllers must finish before any members attempt to join.
  for (const role of ['controller', 'member']) {
    await mapConcurrent(windowsTargets.filter(target => target.domainRole === role), 5, async target => {
      if (['succeeded', 'failed'].includes(store.records[target.vmid].status)) return;
      try {
        await step(target, 'domain', 'windows-domain-playbook.yml', [], false);
        await store.update(target.vmid, { status: finishedStatus(target), error: null });
      } catch (error) { await fail(target, error); }
    });
  }
  // Global barrier: never inject a fault while another VM's standard setup failed.
  const preparationFailed = Object.values(store.records).some(record => record.status === 'failed');
  const readinessFailed = (job.data.readinessFailedVmids || []).length > 0;
  if (!preparationFailed && !readinessFailed) {
    await mapConcurrent(targets, 5, async target => {
      if (!blocks.get(target.vmid).length) return;
      try {
        for (const block of blocks.get(target.vmid)) {
          const checkpoint = taskCheckpoint(block);
          if (store.records[target.vmid].completedSteps.includes(checkpoint)) continue;
          const started = Date.now();
          const taskResults = { ...store.records[target.vmid].taskResults,
            [block.id]: { name: block.name, status: 'running', startedAt: new Date(started).toISOString() } };
          await store.update(target.vmid, { status: 'running', step: `Ansible: ${block.name}`, attempt: 1, maxAttempts: 1, error: null, lastResponse: null, taskResults });
          try {
            const result = await runTaskBlock({ block, target, linuxUser: extraVars.linux_default_username,
              password: extraVars.windows_admin_password, signal });
            const output = result.output?.slice(-8000) || 'Task block completed';
            taskResults[block.id] = { ...taskResults[block.id], status: 'succeeded', durationMs: Date.now() - started, output, image: result.image };
            await store.update(target.vmid, { lastResponse: output, taskResults }, checkpoint);
          } catch (error) {
            taskResults[block.id] = { ...taskResults[block.id], status: 'failed', durationMs: Date.now() - started, error: commandFailure(error) };
            await store.update(target.vmid, { taskResults });
            throw error;
          }
        }
        await store.update(target.vmid, { status: 'succeeded', error: null });
      } catch (error) { await fail(target, error); }
    });
  }
  const failed = Object.values(store.records).filter(record => record.status !== 'succeeded');
  if (readinessFailed) throw new Error('Custom tasks blocked: some lab VMs failed guest readiness');
  if (failed.length) throw new Error(failed.map(record => `${record.name} (VM ${record.vmid}), ${record.step}, attempt ${record.attempt || 1}: ${record.error}`).join('; '));
}
