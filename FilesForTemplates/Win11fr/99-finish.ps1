# 99-finish.ps1
# This script runs at the end of Cloudbase-Init via LocalScriptsPlugin
# LabFactory reads this flag through QEMU Guest Agent, without a network connection.
# Fail instead of reporting success if writing the marker fails.
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path "C:\ProgramData\cloudbase-init" | Out-Null

$flag = "C:\ProgramData\cloudbase-init\done.flag"
"cloudbase-init complete $(Get-Date -Format s)" | Set-Content $flag -Encoding ASCII

# Désactiver le service pour qu'il ne se ré-exécute plus au prochain démarrage
Set-Service -Name 'cloudbase-init'  -StartupType Disabled -ErrorAction SilentlyContinue
Set-Service -Name 'cloudbaseinit'   -StartupType Disabled -ErrorAction SilentlyContinue

exit 0