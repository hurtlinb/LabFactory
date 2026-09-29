import { setTimeout as delay } from 'node:timers/promises';

// Deliberately narrow: configuration, authentication and guest disk errors must not loop.
export function isTransientConnectionError(message) {
  const text = String(message);
  if (/unauthorized|authentication|credentials|access.denied|permission.denied|disk.full|not enough space|no space left|certificate.verify/i.test(text)) return false;
  return /connect(?:ion)?\s*timed?\s*out|ConnectTimeout|ReadTimeout|read timed out|connection (?:reset|refused|aborted)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|RemoteDisconnected|temporarily unavailable|WinRMOperationTimeout/i.test(text);
}

export function commandFailure(error) {
  // Never include command arguments (which historically contained guest passwords).
  const output = String(error.stdout || error.stderr || '');
  const fatal = output.split('\n').filter(line => /fatal:|FAILED!|UNREACHABLE!/.test(line)).at(-1);
  return (fatal || (output ? output.slice(-1500) : error.message)).slice(0, 2000);
}

export async function retryConnectionOperation({ run, probe, report, signal, sleep = ms => delay(ms, undefined, { signal }) }) {
  let needsProbe = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    signal?.throwIfAborted();
    try {
      if (needsProbe) await probe();
      await report({ attempt, status: 'running', lastResponse: needsProbe ? 'WinRM responded' : null });
      await run();
      return;
    } catch (error) {
      signal?.throwIfAborted();
      const message = commandFailure(error);
      const retry = attempt < 4 && isTransientConnectionError(message);
      await report({ attempt, status: retry ? 'retrying' : 'failed', error: message });
      if (!retry) throw new Error(message);
      needsProbe = true;
      await sleep([15000, 30000, 60000][attempt - 1]);
    }
  }
}

export function customizationProgress(records) {
  const values = Object.values(records);
  return {
    type: 'customization-steps',
    targetVmids: values.map(vm => vm.vmid),
    reconnectedVmids: values.filter(vm => vm.status === 'succeeded').map(vm => vm.vmid),
    failedVmids: values.filter(vm => vm.status === 'failed').map(vm => vm.vmid),
    results: values
  };
}

// Serialize Redis writes so concurrently finishing VMs cannot overwrite checkpoints.
export function createCustomizationStore(job, targets) {
  const records = structuredClone(job.data.customizationResults || {});
  for (const target of targets) records[target.vmid] ??= {
    vmid: Number(target.vmid), name: target.name, status: 'pending', completedSteps: []
  };
  let pending = Promise.resolve();
  const update = (vmid, patch = {}, completedStep) => {
    pending = pending.then(async () => {
      const record = records[vmid];
      Object.assign(record, patch);
      if (completedStep && !record.completedSteps.includes(completedStep)) record.completedSteps.push(completedStep);
      await job.updateData({ ...job.data, customizationResults: records });
      await job.updateProgress(customizationProgress(records));
    });
    return pending;
  };
  return { records, update };
}

export async function mapConcurrent(items, concurrency, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await action(items[next++]);
  }));
}
