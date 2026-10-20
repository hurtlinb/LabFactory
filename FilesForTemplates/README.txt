Cloudbase-Init + Terraform Wait Example (Proxmox / Windows Server)

Files included:

cloudbase-init.conf
  Place in:
  C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf\

99-finish.ps1
  Place in:
  C:\Program Files\Cloudbase Solutions\Cloudbase-Init\LocalScripts\

terraform_wait.tf
  Example Terraform resource that waits until Cloudbase-Init finishes.

Workflow:

1. Cloudbase-Init runs network/password plugins and writes the completion flag.
2. If LabFactory custom naming is enabled for a Windows VM, Terraform renames the guest over WinRM and reboots it.
3. LocalScriptsPlugin executes scripts in LocalScripts.
4. 99-finish.ps1 writes:
   C:\ProgramData\cloudbase-init\done.flag
5. Terraform waits until the file exists using WinRM.

Important:
Run Sysprep AFTER placing the config and script.

Windows inventory pools:
- QEMU Guest Agent must be installed and start automatically. LabFactory uses it
  to observe Windows Setup without an IP address.
- Sysprep must use the appropriate unattended answer file so specialize/OOBE can
  complete without a user clicking through setup.
- Before sealing the template, remove old completion markers and re-enable the
  Cloudbase-Init service (99-finish.ps1 disables it after a completed boot):

  Remove-Item 'C:\ProgramData\cloudbase-init\done.flag' -ErrorAction SilentlyContinue
  Remove-Item 'C:\ProgramData\cloudbase-init\labfactory-pool-ready.flag' -ErrorAction SilentlyContinue
  Get-Service -Name 'cloudbase-init','cloudbaseinit' -ErrorAction SilentlyContinue | Set-Service -StartupType Automatic

LabFactory boots inventory clones with their NICs disconnected. A Windows VM is
ready only after Windows Setup is complete and a new done.flag has been written.
It stays powered on. On lab assignment, QEMU Guest Agent applies the lab password
and static network settings; Cloudbase-Init and Sysprep are not run again.

Command:
sysprep /generalize /oobe /shutdown /mode:vm /unattend:C:\path\to\unattend.xml
