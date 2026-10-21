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

Command:
sysprep /generalize /oobe /shutdown /mode:vm
