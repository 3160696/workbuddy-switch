param([Parameter(Mandatory=$true)][string]$Exe,[ValidateSet('status','stop','start')][string]$Mode='status')
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw 'CodeBuddy CN executable not found.' }
$resolved=(Resolve-Path -LiteralPath $Exe).Path
if ([IO.Path]::GetFileName($resolved) -ine 'CodeBuddy CN.exe') { throw 'Select the official CodeBuddy CN.exe executable.' }
function Matching-Processes { @(Get-Process -Name 'CodeBuddy CN' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $resolved }) }
if ($Mode -eq 'stop') {
    foreach($target in (Matching-Processes)) { if($target.MainWindowHandle -ne 0) { $null=$target.CloseMainWindow() } }
    for($i=0;$i -lt 60;$i++) { if((Matching-Processes).Count -eq 0){break};Start-Sleep -Milliseconds 250 }
    # Never force-terminate an editor with unsaved files or a pending confirmation.
    if((Matching-Processes).Count -gt 0) { throw 'Save files and close CodeBuddy CN before switching.' }
}
if ($Mode -eq 'start') {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $resolved -WorkingDirectory ([IO.Path]::GetDirectoryName($resolved)) -WindowStyle Normal
    for($i=0;$i -lt 40;$i++) { if((Matching-Processes).Count -gt 0){break};Start-Sleep -Milliseconds 250 }
    if((Matching-Processes).Count -eq 0) { throw 'CodeBuddy CN did not start.' }
}
@{running=((Matching-Processes).Count -gt 0)} | ConvertTo-Json -Compress
