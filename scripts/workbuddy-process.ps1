param([Parameter(Mandatory=$true)][string]$Exe,[ValidateSet('status','stop','start')][string]$Mode='status')
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw 'WorkBuddy executable not found.' }
$resolved=(Resolve-Path -LiteralPath $Exe).Path
if ([IO.Path]::GetFileName($resolved) -ine 'WorkBuddy.exe') { throw 'Select the official WorkBuddy.exe executable.' }
function Matching-Processes { @(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $resolved }) }
if ($Mode -eq 'stop') {
    $targets=Matching-Processes
    foreach($target in $targets) { if($target.MainWindowHandle -ne 0) { $null=$target.CloseMainWindow() } }
    if($targets.Count -gt 0) { Start-Sleep -Milliseconds 1200 }
    Matching-Processes | Stop-Process -ErrorAction SilentlyContinue
    for($i=0;$i -lt 40;$i++) { if((Matching-Processes).Count -eq 0){break};Start-Sleep -Milliseconds 250 }
    if((Matching-Processes).Count -gt 0) { throw 'WorkBuddy is still running; no account files were changed.' }
}
if ($Mode -eq 'start') {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # This is the user's interactive client, so its main window must be visible.
    Start-Process -FilePath $resolved -WorkingDirectory ([IO.Path]::GetDirectoryName($resolved)) -WindowStyle Normal
    for($i=0;$i -lt 30;$i++) { if((Matching-Processes).Count -gt 0){break};Start-Sleep -Milliseconds 250 }
    if((Matching-Processes).Count -eq 0) { throw 'WorkBuddy did not start.' }
}
@{running=((Matching-Processes).Count -gt 0)} | ConvertTo-Json -Compress
