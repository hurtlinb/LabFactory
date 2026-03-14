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

1. Cloudbase-Init runs hostname/network/password plugins.
2. LocalScriptsPlugin executes scripts in LocalScripts.
3. 99-finish.ps1 writes:
   C:\ProgramData\cloudbase-init\done.flag
4. Terraform waits until the file exists using WinRM.

Important:
Run Sysprep AFTER placing the config and script.

Command:
sysprep /generalize /oobe /shutdown /mode:vm