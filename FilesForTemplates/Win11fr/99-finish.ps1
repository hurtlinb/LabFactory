# 99-finish.ps1
# This script runs at the end of Cloudbase-Init via LocalScriptsPlugin
# It creates a flag file that Terraform can wait for.

New-Item -ItemType Directory -Force -Path "C:\ProgramData\cloudbase-init" | Out-Null

$flag = "C:\ProgramData\cloudbase-init\done.flag"
"cloudbase-init complete $(Get-Date -Format s)" | Set-Content $flag -Encoding ASCII

# Désactiver le service pour qu'il ne se ré-exécute plus au prochain démarrage
Set-Service -Name 'cloudbase-init'  -StartupType Disabled -ErrorAction SilentlyContinue
Set-Service -Name 'cloudbaseinit'   -StartupType Disabled -ErrorAction SilentlyContinue

exit 0