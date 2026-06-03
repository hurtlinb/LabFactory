# 99-finish.ps1
# This script runs at the end of Cloudbase-Init via LocalScriptsPlugin
# It creates a flag file that Terraform can wait for.

New-Item -ItemType Directory -Force -Path "C:\ProgramData\cloudbase-init" | Out-Null

$flag = "C:\ProgramData\cloudbase-init\done.flag"
"cloudbase-init complete $(Get-Date -Format s)" | Set-Content $flag -Encoding ASCII

exit 0