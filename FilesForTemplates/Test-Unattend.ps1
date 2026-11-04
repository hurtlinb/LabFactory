# Static checks only: does not run any provisioning command.
# This does not replace Windows SIM validation against the target image.
param(
    [string[]]$Path = @(
        "$PSScriptRoot\Win11v2\unattend.xml",
        "$PSScriptRoot\Win22\unattend.xml",
        "$PSScriptRoot\Win25\unattend.xml"
    )
)
$ErrorActionPreference = 'Stop'
foreach ($file in $Path) {
    [xml]$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $file
    $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('u', 'urn:schemas-microsoft-com:unattend')
    $commands = $doc.SelectNodes('//u:RunSynchronousCommand/u:Path', $ns)
    if ($commands.Count -eq 0) { throw "No synchronous commands in $file" }
    foreach ($command in $commands) {
        $text = $command.InnerText
        if ($text.Length -gt 259) {
            throw "RunSynchronous Path exceeds 259 characters in ${file}: $($text.Length)"
        }
        if ($text -match '^powershell\.exe .* -Command "(.*)"$') {
            $tokens = $null
            $parseErrors = $null
            $null = [System.Management.Automation.Language.Parser]::ParseInput(
                $Matches[1], [ref]$tokens, [ref]$parseErrors)
            if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
        }
    }
    if ($doc.SelectNodes('//u:settings[@pass!="oobeSystem"]//u:FirstLogonCommands', $ns).Count) {
        throw "FirstLogonCommands outside oobeSystem in $file"
    }
    Write-Output "PASS: $file (XML, command lengths and PowerShell syntax)"
}
