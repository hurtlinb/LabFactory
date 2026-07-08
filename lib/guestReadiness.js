import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { runCommand } from './runCommand.js';

export const WINDOWS_WINRM_WAIT_TIMEOUT_MS = 120 * 60 * 1000;
export const WINDOWS_WINRM_ATTEMPT_TIMEOUT_SECONDS = 45;

const READINESS_RETRY_BACKOFF_STEPS = [
  { afterMs: 0, delayMs: 5000 },
  { afterMs: 60 * 1000, delayMs: 15000 },
  { afterMs: 5 * 60 * 1000, delayMs: 30000 }
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ansibleDir = path.resolve(__dirname, '../ansible');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const isWindowsOsType = osType => ['windows11', 'windows-server'].includes(String(osType ?? ''));

export const getWindowsAdminUsername = language =>
  String(language ?? '').trim().toLowerCase() === 'fr' ? 'Administrateur' : 'Administrator';

export const computeReadinessRetryDelayMs = elapsedMs => {
  let delayMs = READINESS_RETRY_BACKOFF_STEPS[0].delayMs;
  for (const step of READINESS_RETRY_BACKOFF_STEPS) {
    if (elapsedMs >= step.afterMs) {
      delayMs = step.delayMs;
    }
  }
  return delayMs;
};

export const windowsCloudbaseReadinessPlaybook = `- name: Wait for Windows Cloudbase-Init
  hosts: windows_readiness_targets
  gather_facts: false
  tasks:
    - name: Check Cloudbase-Init completion for current boot
      ansible.windows.win_powershell:
        script: |
          $flag = 'C:\\ProgramData\\cloudbase-init\\done.flag'
          if (-not (Test-Path -LiteralPath $flag)) {
            Write-Error 'Cloudbase-Init has not finished'
            exit 1
          }

          $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
          $flagTime = (Get-Item -LiteralPath $flag).LastWriteTime
          if ($flagTime -lt $bootTime) {
            Write-Error "Cloudbase-Init done flag is stale: $flagTime is before boot $bootTime"
            exit 1
          }

          $cloudbaseServices = Get-Service -Name 'cloudbase-init','cloudbaseinit' -ErrorAction SilentlyContinue
          $activeServices = @($cloudbaseServices | Where-Object { $_.Status -in @('StartPending', 'Running', 'ContinuePending') })
          if ($activeServices.Count -gt 0) {
            Write-Error "Cloudbase-Init service is still active: $($activeServices.Name -join ', ')"
            exit 1
          }

          Write-Output "Cloudbase-Init completed at $flagTime and WinRM is reachable"
`;

export const buildWindowsReadinessInventory = (target, password) => `all:
  children:
    windows_readiness_targets:
      hosts:
        vm_${target.vmid}:
          ansible_host: ${JSON.stringify(target.host)}
          ansible_user: ${JSON.stringify(target.user)}
          ansible_password: ${JSON.stringify(password)}
          ansible_connection: winrm
          ansible_port: 5986
          ansible_winrm_scheme: https
          ansible_winrm_transport: basic
          ansible_winrm_server_cert_validation: ignore
          ansible_winrm_operation_timeout_sec: 8
          ansible_winrm_read_timeout_sec: 12
`;

export const waitForWindowsHostReadiness = async ({ target, password, signal }) => {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < WINDOWS_WINRM_WAIT_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Windows readiness wait aborted');
    }

    const attemptDir = path.join(tmpdir(), `labfactory-windows-readiness-${target.vmid}-${process.pid}-${Date.now()}`);
    await mkdir(attemptDir, { recursive: true });
    const inventoryPath = path.join(attemptDir, 'inventory.yml');
    const playbookPath = path.join(attemptDir, 'playbook.yml');

    try {
      await writeFile(inventoryPath, buildWindowsReadinessInventory(target, password), 'utf8');
      await writeFile(playbookPath, windowsCloudbaseReadinessPlaybook, 'utf8');

      await runCommand(
        'timeout',
        [`${WINDOWS_WINRM_ATTEMPT_TIMEOUT_SECONDS}s`, 'ansible-playbook', '--inventory', inventoryPath, playbookPath],
        { cwd: ansibleDir, env: { ...process.env }, signal }
      );
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await rm(attemptDir, { recursive: true, force: true });
    }

    await sleep(computeReadinessRetryDelayMs(Date.now() - startedAt));
  }

  throw new Error(
    `Timed out waiting for Windows guest ${target.name} to accept stable WinRM and finish Cloudbase-Init${lastError ? `: ${lastError.message}` : ''}`
  );
};

export const waitForWindowsTargetsReadiness = async ({ targets, password, signal }) => {
  await Promise.all(
    targets.map(target =>
      waitForWindowsHostReadiness({
        target,
        password,
        signal
      })
    )
  );
};
