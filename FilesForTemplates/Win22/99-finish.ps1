# 99-finish.ps1
# This script runs at the end of Cloudbase-Init via LocalScriptsPlugin
# It creates a flag file that Terraform can wait for.

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path "C:\ProgramData\cloudbase-init" | Out-Null

$flag = "C:\ProgramData\cloudbase-init\done.flag"
"cloudbase-init complete $(Get-Date -Format s)" | Set-Content $flag -Encoding ASCII

# Keep the service enabled for future clones. Cloudbase-Init tracks plugin
# execution itself; stop_service_on_exit=true stops this run without disabling it.

exit 0
