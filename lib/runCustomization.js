import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createCustomizationStore, retryConnectionOperation, retryRebootOperation, commandFailure } from './customizationRecovery.js';
import { activeAnsibleTasks, taskCheckpoint, guestPasswordFor } from './ansibleTasks.js';
import { runAnsibleTaskBlock } from './runAnsibleTasks.js';
import { domainControllersFor } from './windowsPool/dependencies.js';

// Task runners redact guest credentials before returning output or throwing errors.
const taskFailureOutput = error => [...new Set([error.stdout, error.stderr].filter(Boolean))]
  .join('\n').slice(-8000);

export function customizationConcurrency(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : 5;
}

// Local FIFO limiter: only an Ansible command holds a slot (waits, reconnections and
// retry backoffs never do). The worker can inject a distributed limiter instead.
export function createLocalLimiter(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); drain(); });
}

// Customization orchestration (lot P4d). Scheduling by real dependencies:
//  - Linux and Windows VMs progress in parallel (no more "all Linux, then all Windows");
//  - for each VM, its chain stays ordered (setup -> files -> reboot -> reconnect -> domain);
//  - a domain member waits ONLY for the controller(s) of its domain on its network
//    (domainControllersFor), not for every controller of the lab;
// Kept business barriers (semantics unchanged):
//  - every block validation succeeds BEFORE any mutation (validations in parallel);
//  - no fault injection (task blocks) if a preparation or a readiness failed.
// Resume: the checkpoints (completedSteps, status) are unchanged.
export async function runCustomization({ job, windowsTargets, linuxTargets, directory, inventoryPath, extraVars, ansibleDir, runCommand, reconnect, buildProbeInventory, probePlaybook, signal, runTaskBlock = runAnsibleTaskBlock, rebootRetrySleep, limit = createLocalLimiter(customizationConcurrency(process.env.CUSTOMIZATION_CONCURRENCY)) }) {
  const store = createCustomizationStore(job, [...linuxTargets, ...windowsTargets]);
  const targets = [...linuxTargets, ...windowsTargets];
  const blocks = new Map(targets.map(target => [target.vmid, activeAnsibleTasks(target)]));
  const finishedStatus = target => blocks.get(target.vmid).length ? 'pending' : 'succeeded';

  // Barrier: validate every enabled block in the actual execution image before changing any VM.
  // The validations are independent: in parallel; the first failure is raised once all of them are done.
  const validations = targets.flatMap(target => blocks.get(target.vmid).map(block => ({ target, block })));
  const validationResults = await Promise.allSettled(validations.map(({ target, block }) =>
    limit(() => runTaskBlock({ block, target, syntaxOnly: true, signal }))));
  const firstInvalid = validationResults.findIndex(result => result.status === 'rejected');
  if (firstInvalid !== -1) {
    for (const [index, result] of validationResults.entries()) {
      if (result.status !== 'rejected') continue;
      const { target, block } = validations[index];
      await store.update(target.vmid, { status: 'failed', step: `Validate Ansible: ${block.name}`, error: commandFailure(result.reason),
        taskResults: { ...store.records[target.vmid].taskResults, [block.id]: { name: block.name, status: 'failed', error: commandFailure(result.reason), output: taskFailureOutput(result.reason) } } });
    }
    throw validationResults[firstInvalid].reason;
  }

  const varsPath = path.join(directory, 'vars.json');
  await fs.writeFile(varsPath, JSON.stringify(extraVars), { mode: 0o600 });
  const commonArgs = ['--inventory', inventoryPath, '--extra-vars', '@' + varsPath];
  const options = { cwd: ansibleDir, env: { ...process.env }, signal };
  const execute = (playbook, host, args = []) => limit(() => runCommand('ansible-playbook', [path.join(ansibleDir, playbook), ...commonArgs, '--limit', host, ...args], options));
  const password = target => guestPasswordFor(target, extraVars.windows_admin_password);
  const fail = async (target, error) => {
    signal?.throwIfAborted();
    await store.update(target.vmid, { status: 'failed', error: commandFailure(error) });
  };
  const step = async (target, name, playbook, args = [], retry = true) => {
    if (store.records[target.vmid].completedSteps.includes(name)) return;
    const host = 'vm_' + (windowsTargets.indexOf(target) + 1);
    const run = () => execute(playbook, host, args);
    await store.update(target.vmid, { status: 'running', step: name, error: null, attempt: 0, lastResponse: null });
    if (retry === 'reboot') {
      await retryRebootOperation({
        run, signal, ...(rebootRetrySleep && { sleep: rebootRetrySleep }),
        waitForGuest: () => reconnect({ target, password: password(target), signal }),
        report: patch => store.update(target.vmid, patch)
      });
    } else if (retry) {
      await retryConnectionOperation({
        run, signal,
        probe: async () => {
          const inventory = path.join(directory, 'probe-' + target.vmid + '.yml');
          const playbookPath = path.join(directory, 'ping-' + target.vmid + '.yml');
          await fs.writeFile(inventory, buildProbeInventory(target, password(target)), { mode: 0o600 });
          await fs.writeFile(playbookPath, probePlaybook);
          try {
            await limit(() => runCommand('timeout', ['45s', 'ansible-playbook', '-i', inventory, playbookPath], options));
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

  // --- Preparation chains, one per VM, all started at once -----------------------------
  const linuxChain = async target => {
    if (store.records[target.vmid].status === 'succeeded') return;
    try {
      await store.update(target.vmid, { status: 'running', step: 'linux', error: null });
      if (!store.records[target.vmid].completedSteps.includes('linux')) {
        await execute('linux-playbook.yml', 'linux_vm_' + (linuxTargets.indexOf(target) + 1));
      }
      await store.update(target.vmid, { status: finishedStatus(target), error: null }, 'linux');
    } catch (error) { await fail(target, error); }
  };

  // Standard Windows preparation (without the domain): resolves true if it succeeded.
  const windowsPreparation = new Map();
  const windowsBase = async target => {
    if (store.records[target.vmid].status === 'succeeded') return true;
    try {
      await store.update(target.vmid, { status: 'running', error: null });
      await step(target, 'setup', 'windows-playbook.yml', ['--tags', 'setup']);
      for (const [index, file] of target.stagedFileUploads.entries()) {
        const fileVars = path.join(directory, 'file-' + target.vmid + '-' + index + '.json');
        await fs.writeFile(fileVars, JSON.stringify({ file_uploads: [file] }), { mode: 0o600 });
        await step(target, 'copy: ' + file.destination, 'windows-playbook.yml', ['--tags', 'files', '--extra-vars', '@' + fileVars]);
      }
      await step(target, 'reboot', 'windows-playbook.yml', ['--tags', 'reboot'], 'reboot');
      if (!store.records[target.vmid].completedSteps.includes('reconnect')) {
        await store.update(target.vmid, { status: 'running', step: 'reconnect', error: null });
        await reconnect({ target, password: password(target), signal });
        await store.update(target.vmid, { error: null, lastResponse: 'WinRM responded' }, 'reconnect');
      }
      await store.update(target.vmid, { status: target.domainRole ? 'pending' : finishedStatus(target) });
      return true;
    } catch (error) { await fail(target, error); return false; }
  };

  // Domain step: the controller as soon as its own preparation is done; a member as soon as ITS
  // controller(s) (same domain + network) FINISHED their domain step, independently of the
  // other domains/workstations. As before, the member attempts its join whatever the
  // controller's outcome (unchanged semantics: only the waiting scope is narrowed).
  const domainDone = new Map();
  const windowsChain = async target => {
    const prepared = await windowsPreparation.get(target.vmid);
    if (!target.domainRole || !prepared) return prepared;
    if (target.domainRole === 'member') {
      await Promise.all(domainControllersFor(target, windowsTargets).map(controller => domainDone.get(controller.vmid)));
    }
    if (['succeeded', 'failed'].includes(store.records[target.vmid].status)) return store.records[target.vmid].status === 'succeeded';
    try {
      await step(target, 'domain', 'windows-domain-playbook.yml', [], false);
      await store.update(target.vmid, { status: finishedStatus(target), error: null });
      return true;
    } catch (error) { await fail(target, error); return false; }
  };

  for (const target of windowsTargets) windowsPreparation.set(target.vmid, windowsBase(target));
  for (const target of windowsTargets) domainDone.set(target.vmid, windowsChain(target));
  await Promise.all([...linuxTargets.map(linuxChain), ...domainDone.values()]);

  // Global barrier: never inject a fault while another VM's standard setup failed.
  const preparationFailed = Object.values(store.records).some(record => record.status === 'failed');
  const readinessFailed = (job.data.readinessFailedVmids || []).length > 0;
  if (!preparationFailed && !readinessFailed) {
    await Promise.all(targets.map(async target => {
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
            // Password of the VM itself (per-workstation mode), not the lab's shared password.
            const result = await limit(() => runTaskBlock({ block, target, linuxUser: extraVars.linux_default_username,
              password: password(target), signal }));
            const output = result.output?.slice(-8000) || 'Task block completed';
            taskResults[block.id] = { ...taskResults[block.id], status: 'succeeded', durationMs: Date.now() - started, output, image: result.image };
            await store.update(target.vmid, { lastResponse: output, taskResults }, checkpoint);
          } catch (error) {
            taskResults[block.id] = { ...taskResults[block.id], status: 'failed', durationMs: Date.now() - started, error: commandFailure(error), output: taskFailureOutput(error) };
            await store.update(target.vmid, { taskResults });
            throw error;
          }
        }
        await store.update(target.vmid, { status: 'succeeded', error: null });
      } catch (error) { await fail(target, error); }
    }));
  }
  const failed = Object.values(store.records).filter(record => record.status !== 'succeeded');
  if (readinessFailed) throw new Error('Custom tasks blocked: some lab VMs failed guest readiness');
  if (failed.length) throw new Error(failed.map(record => `${record.name} (VM ${record.vmid}), ${record.step}, attempt ${record.attempt || 1}: ${record.error}`).join('; '));
}
