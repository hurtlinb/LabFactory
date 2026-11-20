// Dependency graph of a lab's assignment and customizations (P1 contract, executed in P4).
// Principle: serialization is local to the real dependencies. A VM never waits
// for the slowest VM of the lab to progress through an independent step.
//
// Kept business barriers (semantics unchanged until an explicit review):
//  - AD: a member's domain join waits for the domain step of the controller of the SAME
//    domain on the SAME network (/24 subnet, same rule as workers/ansibleWorker.js), not
//    for every controller of the lab;
//  - fault injection (Ansible blocks): "every preparation succeeded before any mutation",
//    i.e. a global barrier on the preparation steps of every VM of the lab (lib/runCustomization.js).

export const WINDOWS_POOL_CHAIN = Object.freeze(['assign-network', 'connect', 'winrm', 'setup', 'files', 'reboot', 'reconnect']);
export const LINUX_CHAIN = Object.freeze(['linux']);
export const BARRIER = 'barrier:preparations';

const key = (vmid, step) => `${vmid}:${step}`;
const subnet24 = ip => String(ip ?? '').split('.').slice(0, 3).join('.');

// Controllers a domain member depends on: same domain AND same /24 network (rule of
// workers/ansibleWorker.js for domain_controller_ip). Empty if none: the member proceeds without dependency.
export function domainControllersFor(member, targets) {
  if (member?.domainRole !== 'member' || !member.domainName) return [];
  return targets.filter(t => t.domainRole === 'controller' && t.domainName === member.domainName &&
    subnet24(t.ipAddress) === subnet24(member.ipAddress));
}

// targets: [{ vmid, osType: 'windows'|'linux', fromPool, ipAddress, domainRole, domainName, hasTaskBlocks }]
export function buildCustomizationGraph(targets) {
  const nodes = new Map();
  const add = (id, meta, deps = []) => {
    if (nodes.has(id)) throw new Error(`Duplicate graph node: ${id}`);
    nodes.set(id, { id, ...meta, deps: new Set(deps) });
  };
  const preparationEnds = [];
  for (const target of targets) {
    if (!Number.isInteger(target.vmid)) throw new Error('Target without a VMID');
    const chain = target.osType === 'windows'
      ? (target.fromPool ? WINDOWS_POOL_CHAIN : WINDOWS_POOL_CHAIN.slice(2)) // historical VMs: no network assignment
      : LINUX_CHAIN;
    let previous = null;
    for (const step of chain) {
      add(key(target.vmid, step), { vmid: target.vmid, step }, previous ? [previous] : []);
      previous = key(target.vmid, step);
    }
    if (target.osType === 'windows' && target.domainRole) {
      add(key(target.vmid, 'domain'), { vmid: target.vmid, step: 'domain' }, [previous]);
      previous = key(target.vmid, 'domain');
    }
    preparationEnds.push(previous);
  }
  // AD dependencies, scoped by domain + network.
  for (const member of targets.filter(t => t.domainRole === 'member')) {
    const controllers = domainControllersFor(member, targets);
    if (!controllers.length) throw new Error(`Domain member ${member.vmid} without a controller for ${member.domainName} on its network`);
    for (const controller of controllers) nodes.get(key(member.vmid, 'domain')).deps.add(key(controller.vmid, 'domain'));
  }
  // Fault-injection barrier (only if at least one block exists).
  if (targets.some(t => t.hasTaskBlocks)) {
    add(BARRIER, { vmid: null, step: BARRIER }, preparationEnds);
    for (const target of targets.filter(t => t.hasTaskBlocks)) {
      add(key(target.vmid, 'tasks'), { vmid: target.vmid, step: 'tasks' }, [BARRIER]);
    }
  }
  assertAcyclic(nodes);
  return nodes;
}

function assertAcyclic(nodes) {
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`Dependency cycle at ${id}`);
    state.set(id, 'visiting');
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!nodes.has(dep)) throw new Error(`Unknown dependency ${dep} for ${id}`);
      visit(dep);
    }
    state.set(id, 'done');
  };
  for (const id of nodes.keys()) visit(id);
}

// statuses: Map(id -> 'pending'|'running'|'succeeded'|'failed'|'blocked').
// Returns the steps to start now (every prerequisite succeeded) and those to mark
// blocked (a prerequisite failed or is blocked). The scheduler starts them all,
// within the distributed limits (leases).
export function nextSteps(nodes, statuses) {
  const runnable = [];
  const blocked = [];
  for (const node of nodes.values()) {
    const status = statuses.get(node.id) ?? 'pending';
    if (status !== 'pending') continue;
    const depStatuses = [...node.deps].map(dep => statuses.get(dep) ?? 'pending');
    if (depStatuses.some(value => value === 'failed' || value === 'blocked')) blocked.push(node.id);
    else if (depStatuses.every(value => value === 'succeeded')) runnable.push(node.id);
  }
  return { runnable, blocked };
}
