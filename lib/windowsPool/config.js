import { z } from 'zod';

const proxmoxName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

// Per-template configuration as edited (P6) and read by the manager (P2).
export const templatePoolConfigSchema = z.object({
  templateId: z.uuid(),
  enabled: z.boolean(),
  readyTarget: z.number().int().min(0).max(500),
  maxCapacity: z.number().int().min(1).max(500),
  maxParallelPreparations: z.number().int().min(1).max(32),
  node: proxmoxName.nullable(),
  storage: proxmoxName.nullable(),
  revision: z.number().int().min(1),
  sourceTemplateVmid: z.number().int().min(100),
  cloneMode: z.literal('linked'),
  preparationTimeoutSeconds: z.number().int().min(300).max(7200),
  assignmentTimeoutSeconds: z.number().int().min(60).max(3600)
}).superRefine((config, ctx) => {
  if (config.readyTarget > config.maxCapacity) {
    ctx.addIssue({ code: 'custom', path: ['readyTarget'], message: 'The ready target must not exceed the maximum capacity' });
  }
  if (config.enabled && (!config.node || !config.storage)) {
    ctx.addIssue({ code: 'custom', path: ['node'], message: 'An enabled template requires a node and a storage' });
  }
});

export function parseTemplatePoolConfig(value) {
  return templatePoolConfigSchema.parse(value);
}

export const mapTemplatePoolRow = row => ({
  templateId: row.template_id,
  enabled: row.enabled,
  readyTarget: row.ready_target,
  maxCapacity: row.max_capacity,
  maxParallelPreparations: row.max_parallel_preparations,
  node: row.node,
  storage: row.storage,
  revision: row.revision,
  sourceTemplateVmid: row.source_template_vmid,
  cloneMode: row.clone_mode,
  preparationTimeoutSeconds: row.preparation_timeout_seconds,
  assignmentTimeoutSeconds: row.assignment_timeout_seconds
});

const WINDOWS_OS_TYPES = new Set(['windows-server', 'windows11']);
export const isWindowsOsType = osType => WINDOWS_OS_TYPES.has(String(osType ?? ''));

// Windows demand of a lab: number of VMs per template. vms = entries of the deployment
// payload (one per workstation x blueprint VM), with templateId and osType.
export function computeWindowsDemand(vms) {
  const counts = new Map();
  for (const vm of vms) {
    if (!isWindowsOsType(vm.osType)) continue;
    if (!vm.templateId) throw new Error(`Windows VM ${vm.id ?? '?'} without a template: demand cannot be computed`);
    counts.set(vm.templateId, (counts.get(vm.templateId) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([templateId, count]) => ({ templateId, count }));
}

// Number of preparations to start for a template.
// stock = creating + preparing + ready (VMs outside labs); inFlight = creating + preparing.
// waitingDemand = demand of the waiting requests for this template.
// The reserve (readyTarget) and the ceiling (maxCapacity) are distinct: a demand
// above the reserve triggers enough preparations, up to the ceiling.
export function planReplenishment({ config, counts, waitingDemand = 0, paused = false }) {
  const ready = counts.ready ?? 0;
  const inFlight = (counts.creating ?? 0) + (counts.preparing ?? 0);
  const stock = ready + inFlight;
  if (!config.enabled || paused) {
    return { toStart: 0, blocked: waitingDemand > 0 ? (paused ? 'POOL_PAUSED' : 'TEMPLATE_DISABLED') : null };
  }
  // Serve the waiting requests and then restore the reserve.
  const wanted = config.readyTarget + waitingDemand;
  const missing = Math.max(0, wanted - stock);
  const capacityLeft = Math.max(0, config.maxCapacity - stock);
  const parallelLeft = Math.max(0, config.maxParallelPreparations - inFlight);
  const toStart = Math.min(missing, capacityLeft, parallelLeft);
  // The ceiling can never satisfy a demand above maxCapacity: explicit blocking, never a direct clone.
  const blocked = waitingDemand > config.maxCapacity ? 'DEMAND_EXCEEDS_CAPACITY' : null;
  return { toStart, blocked };
}
