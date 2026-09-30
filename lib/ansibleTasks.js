import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

export const collectionCatalog = JSON.parse(readFileSync(new URL('../ansible/collections.json', import.meta.url), 'utf8'));
const fail = message => { throw Object.assign(new Error(message), { code: 'VALIDATION' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reserved = key => /^(ansible_|labfactory_|inventory_|hostvars$|groups$|group_names$|environment$|lookup$|query$|__proto__$|constructor$|prototype$)/.test(key);

export function parseTaskYaml(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 65536) fail('Tasks YAML must contain 1–65536 characters');
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) fail(doc.errors[0].message);
  let value;
  try { value = doc.toJS({ maxAliasCount: 0 }); } catch (error) { fail(error.message); }
  return value;
}

export function validateVariables(value) {
  if (!object(value)) fail('Variables must be a YAML mapping');
  for (const key of Object.keys(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || reserved(key)) fail(`Reserved or invalid variable: ${key}`);
  }
  if (JSON.stringify(value).length > 16384) fail('Variables exceed 16384 characters');
  return value;
}

const keywords = new Set(['name', 'when', 'register', 'vars', 'loop', 'loop_control', 'until', 'retries', 'delay', 'changed_when', 'failed_when', 'ignore_errors', 'ignore_unreachable', 'no_log', 'check_mode', 'diff', 'tags', 'args', 'become', 'become_user', 'become_method', 'environment', 'block', 'rescue', 'always', 'timeout']);
const externalModules = new Set(['include_tasks', 'import_tasks', 'include_role', 'import_role', 'add_host', 'group_by', 'meta']);

function inspectTasks(tasks, collections, depth = 0) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 200 || depth > 10) fail('Expected 1–200 tasks (maximum nesting: 10)');
  for (const task of tasks) {
    if (!object(task)) fail('Each task must be a mapping');
    const modules = Object.keys(task).filter(key => !keywords.has(key));
    if (task.block) {
      if (modules.length) fail('A block cannot contain a module or unsupported task keywords');
      for (const key of ['block', 'rescue', 'always']) if (task[key]) inspectTasks(task[key], collections, depth + 1);
    } else {
      if (task.rescue || task.always) fail('rescue and always require a block');
      if (modules.length !== 1) fail('Each task must use exactly one fully qualified module name');
      const module = modules[0];
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(module)) fail(`Use a fully qualified module name; unsupported keyword or module: ${module}`);
      const [namespace, collection, name] = module.split('.');
      const fqcn = `${namespace}.${collection}`;
      if (fqcn !== 'ansible.builtin' && !collectionCatalog.collections.some(item => item.name === fqcn)) fail(`Collection is not installed: ${fqcn}`);
      if (fqcn === 'ansible.builtin' && externalModules.has(name)) fail(`${module} is not supported in custom tasks`);
      if (module === 'ansible.builtin.set_fact') validateVariables(task[module]);
      collections.add(fqcn);
    }
    if (task.vars !== undefined) validateVariables(task.vars);
    if (task.register !== undefined && (typeof task.register !== 'string' || reserved(task.register))) fail('Reserved or invalid register variable');
    if (task.loop_control?.loop_var && reserved(task.loop_control.loop_var)) fail('Reserved loop variable');
    if (task.loop_control?.index_var && reserved(task.loop_control.index_var)) fail('Reserved loop index variable');
    // Async execution, delegation, connection overrides and external includes are intentionally unsupported.
  }
}

export function validateTaskBlock(block) {
  if (!object(block) || typeof block.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(block.id)) fail('A task block requires a stable ID');
  if (typeof block.name !== 'string' || !block.name.trim() || block.name.length > 120) fail('A task block requires a name (maximum 120 characters)');
  if (block.enabled !== undefined && typeof block.enabled !== 'boolean') fail('enabled must be a boolean');
  const value = parseTaskYaml(block.yaml);
  if (!Array.isArray(value) && (!object(value) || Object.keys(value).some(key => key !== 'tasks'))) fail('Provide a task list or a mapping containing only tasks');
  const tasks = Array.isArray(value) ? value : value.tasks;
  const collections = new Set();
  inspectTasks(tasks, collections);
  const variables = validateVariables(block.variables ?? {});
  return { tasks, variables, collections: [...collections].sort() };
}

export function getAnsibleTasks(config) {
  const blocks = config?.ansibleTasks ?? [];
  if (!Array.isArray(blocks) || blocks.length > 20) fail('A VM supports at most 20 Ansible task blocks');
  const ids = new Set();
  for (const block of blocks) {
    validateTaskBlock(block);
    if (ids.has(block.id)) fail('Duplicate Ansible task block ID');
    ids.add(block.id);
  }
  return blocks;
}

export const activeAnsibleTasks = config => getAnsibleTasks(config).filter(block => block.enabled !== false);
export function taskCheckpoint(block) {
  const parsed = validateTaskBlock(block);
  return `ansible:${block.id}:${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`;
}

export function customPlaybook(block) {
  const { tasks, variables } = validateTaskBlock(block);
  return JSON.stringify([{ name: block.name, hosts: 'target', gather_facts: false, vars: variables, tasks }]);
}
