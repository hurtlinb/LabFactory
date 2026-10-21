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
- In cloudbase-init.conf, LocalScriptsPlugin also requires this explicit setting:
  local_scripts_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\LocalScripts\
  Without it, the plugin can finish successfully without running 99-finish.ps1.
  Apply the corrected config to existing source templates before resealing them;
  updating the application does not update Windows files inside Proxmox templates.
  Recreate affected inventory from the repaired template. Do not create done.flag
  manually to bypass preparation.
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
ready once a done.flag newer than clone creation has been written.
It stays powered on. On lab assignment, the NIC is connected to the lab bridge
and VLAN before QEMU Guest Agent applies the lab password
and static network settings; Cloudbase-Init and Sysprep are not run again.

Command:
sysprep /generalize /oobe /shutdown /mode:vm /unattend:C:\path\to\unattend.xml

Windows 11 French template (Win11fr):
1. Install Cloudbase-Init and QEMU Guest Agent in the source VM. Ensure the
   QEMU Guest Agent service starts automatically and is enabled in Proxmox.
2. Copy Win11fr/cloudbase-init.conf into the Cloudbase-Init conf directory,
   and Win11fr/99-finish.ps1 into its LocalScripts directory (paths above).
3. Copy Win11fr/unattend.xml to C:\unattend.xml. Use this file, not
   unattend_old.xml. The local account is Administrateur, matching the config.
   WinRM commands run in oobeSystem, the supported FirstLogonCommands pass.
4. Remove both old markers and re-enable Cloudbase-Init using the commands
   above, immediately before sealing. Do not run 99-finish.ps1 manually.
5. Run from an elevated console:
   C:\Windows\System32\Sysprep\Sysprep.exe /generalize /oobe /shutdown /mode:vm /unattend:C:\unattend.xml
6. Convert the stopped VM to a Proxmox template without booting it again.
   Recreate existing inventory clones so they receive the updated files.

Validate with a pool size of one: the clone must start, create a fresh
done.flag automatically, and become Ready while remaining powered on.
These file checks do not replace a first-boot test of the rebuilt template.
