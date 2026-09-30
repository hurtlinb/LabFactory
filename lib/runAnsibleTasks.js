import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { customPlaybook, validateTaskBlock } from './ansibleTasks.js';
import { runCommand as defaultRunCommand } from './runCommand.js';

// Only this controller has access to Docker. The task container receives no host mounts,
// Docker socket, application environment, other VMs' passwords or application code.
export async function runAnsibleTaskBlock(options) {
  validateTaskBlock(options.block);
  const backend = process.env.ANSIBLE_TASKS_BACKEND || (process.env.KUBERNETES_SERVICE_HOST ? 'kubernetes' : 'docker');
  if (backend === 'docker') return runDockerTaskBlock(options);
  if (backend !== 'kubernetes') throw new Error(`Unknown Ansible tasks backend: ${backend}`);
  const { runKubernetesTaskBlock } = await import('./runKubernetesTasks.js');
  const password = String(options.target?.windowsAdminPassword ?? options.password ?? '');
  try {
    const result = await runKubernetesTaskBlock({
      playbook: customPlaybook(options.block), inventory: JSON.stringify(buildTaskInventory(options)),
      syntaxOnly: options.syntaxOnly, signal: options.signal
    });
    return { ...result, output: password ? result.output.split(password).join('[redacted]') : result.output };
  } catch (error) {
    for (const key of ['message', 'stdout', 'stderr']) if (error[key] && password) error[key] = String(error[key]).split(password).join('[redacted]');
    throw error;
  }
}

export function buildTaskInventory({ target, linuxUser = 'ubuntu', password = '', syntaxOnly = false }) {
  const windows = ['windows11', 'windows-server'].includes(target?.osType);
  const guestPassword = String(target?.windowsAdminPassword ?? password);
  const host = syntaxOnly ? { ansible_connection: 'local' } : windows ? {
    ansible_host: target.ipAddress,
    ansible_user: target.windowsAdminUsername || (target.language === 'fr' ? 'Administrateur' : 'Administrator'),
    ansible_password: guestPassword, ansible_connection: 'winrm', ansible_port: 5986,
    ansible_winrm_scheme: 'https', ansible_winrm_transport: 'basic', ansible_winrm_server_cert_validation: 'ignore'
  } : {
    ansible_host: target.ipAddress, ansible_user: linuxUser,
    ansible_password: guestPassword, ansible_become_password: guestPassword,
    ansible_connection: 'ssh', ansible_become: true,
    ansible_ssh_common_args: '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
  };
  return { all: { hosts: { target: host } } };
}

async function runDockerTaskBlock({ block, target, linuxUser = 'ubuntu', password = '', syntaxOnly = false, signal, runCommand = defaultRunCommand }) {
  validateTaskBlock(block);
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'labfactory-tasks-'));
  const name = `labfactory-tasks-${randomUUID()}`;
  const image = process.env.ANSIBLE_TASKS_IMAGE || 'labfactory/custom-tasks:1';
  const timeout = AbortSignal.timeout(syntaxOnly ? 45000 : 30 * 60 * 1000);
  const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const options = { signal: operationSignal, quiet: true, maxOutputBytes: 256 * 1024 };
  const guestPassword = String(target?.windowsAdminPassword ?? password);
  try {
    await fs.writeFile(path.join(directory, 'tasks.json'), customPlaybook(block), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'inventory.json'), JSON.stringify(buildTaskInventory({ target, linuxUser, password, syntaxOnly })), { mode: 0o600 });
    await runCommand('docker', ['create', '--name', name, '--label', 'labfactory.custom-tasks=true',
      '--read-only', '--volume', '/workspace', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
      '--memory=512m', '--cpus=1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--network', syntaxOnly ? 'none' : (process.env.ANSIBLE_TASKS_NETWORK || 'bridge'),
      image, '-i', '/workspace/inventory.json', '/workspace/tasks.json', ...(syntaxOnly ? ['--syntax-check'] : [])], options);
    await runCommand('docker', ['cp', `${directory}/.`, `${name}:/workspace`], options);
    const output = await runCommand('docker', ['start', '--attach', name], options);
    const status = await runCommand('docker', ['inspect', '--format', '{{.State.ExitCode}}', name], options);
    if (Number(String(status).trim()) !== 0) throw Object.assign(new Error('Ansible task block failed'), { stdout: output });
    return { output: guestPassword ? output.split(guestPassword).join('[redacted]') : output, image };
  } catch (error) {
    // Suppress the connection password even when a task deliberately prints it.
    for (const key of ['message', 'stdout', 'stderr']) if (error[key] && guestPassword) error[key] = String(error[key]).split(guestPassword).join('[redacted]');
    throw error;
  } finally {
    try {
      await runCommand('docker', ['rm', '--force', '--volumes', name], { quiet: true, signal: AbortSignal.timeout(15000) }).catch(() => {
        console.warn(`Unable to remove custom task container ${name}; check Docker availability`);
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
