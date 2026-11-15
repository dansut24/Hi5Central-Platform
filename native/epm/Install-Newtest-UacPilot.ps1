#requires -RunAsAdministrator
<#
One-build, Newtest-only EPM pilot install.
Installs the verified EPM broker + per-user watcher and review-only UAC tile.
Unknown UAC actions are NOT granted elevation. Both components have rollback.
#>
param(
  [ValidateRange(10,45)][int]$RollbackMinutes=45,
  [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$exe=Join-Path $root 'Hi5CentralEpmPilot.exe'
$dll=Join-Path $root 'Hi5CentralUacTilePilot.dll'
$manifest=Join-Path $root 'SHA256.txt'
$epmInstall=Join-Path $root 'Install-EpmPilot.ps1'
$tileInstall=Join-Path $root 'Install-UacTilePilot.ps1'
$tileUninstall=Join-Path $root 'Uninstall-UacTilePilot.ps1'
$rollbackScript=Join-Path $root 'Uninstall-Newtest-UacPilot.ps1'
foreach($file in @($exe,$dll,$manifest,$epmInstall,$tileInstall,$tileUninstall,$rollbackScript)) {
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw "Pilot bundle is incomplete: $(Split-Path $file -Leaf)"}
}
$checks=@{}
Get-Content -LiteralPath $manifest | ForEach-Object {
  if($_ -match '^([A-Z0-9_]+)=([0-9A-Fa-f]{64})$') {$checks[$matches[1]]=$matches[2].ToUpperInvariant()}
}
if((-not $checks.ContainsKey('EPM_EXE_SHA256')) -or (-not $checks.ContainsKey('UAC_DLL_SHA256'))){
  throw 'Manifest lacks both pinned SHA256 hashes.'
}
if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $checks['EPM_EXE_SHA256']){
  throw 'EPM broker EXE hash mismatch; nothing installed.'
}
if((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ne $checks['UAC_DLL_SHA256']){
  throw 'Native UAC provider DLL hash mismatch; nothing installed.'
}
if($ValidateOnly){
  Write-Host 'PASS: unified EPM/UAC bundle files and pinned binary hashes verified.'
  return
}
if(-not [Environment]::Is64BitProcess){throw 'Use elevated 64-bit Windows PowerShell.'}
# Newtest Lenovo pilot is bound to one enrolled device; no arbitrary endpoint rollout.
$expectedDevice='8b416bc2-ba5a-42d0-9b43-777a6f47af20'
$stateFile=Join-Path $env:ProgramData 'Hi5Central\Agent\state.dat'
if(!(Test-Path -LiteralPath $stateFile)){throw 'Cannot verify Newtest Agent identity.'}
Add-Type -AssemblyName System.Security
$clear=[System.Security.Cryptography.ProtectedData]::Unprotect(
  [System.IO.File]::ReadAllBytes($stateFile),$null,
  [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
try{
  $identity=[System.Text.Encoding]::UTF8.GetString($clear)|ConvertFrom-Json
  $id=if($identity.device_id){$identity.device_id}else{$identity.deviceId}
  if($id -ne $expectedDevice){throw 'This bundle is restricted to the enrolled Newtest Lenovo pilot.'}
} finally {
  [Array]::Clear($clear,0,$clear.Length)
}
$installedRoot=Join-Path $env:ProgramFiles 'Hi5Central\EPM\UacPilotBundle'
$backup=Join-Path $env:ProgramData 'Hi5Central\EPM\UacPilotPrevious'
$previousExe=Join-Path $env:ProgramFiles 'Hi5Central\EPM\Hi5CentralEpmPilot.exe'
$backupExe=Join-Path $backup 'Hi5CentralEpmPilot.previous.exe'
$rollbackTask='Hi5Central-EPM-Newtest-UacPilot-Rollback'
$legacyTile=Join-Path $env:ProgramFiles 'Hi5Central\EPM\UacTilePilot\Uninstall-UacTilePilot.ps1'
if(Get-ScheduledTask -TaskName $rollbackTask -ErrorAction SilentlyContinue){
  throw 'Previous combined pilot rollback is active. Run the previous uninstall first.'
}
New-Item -ItemType Directory -Path $backup,$installedRoot -Force | Out-Null
$serviceExisted=[bool](Get-Service Hi5CentralEpmPilot -ErrorAction SilentlyContinue)
if($serviceExisted -and !(Test-Path -LiteralPath $previousExe)){
  throw 'Existing EPM service binary missing; no changes made.'
}
if($serviceExisted){Copy-Item -LiteralPath $previousExe -Destination $backupExe -Force}
$state=@{serviceExisted=$serviceExisted; installedAt=(Get-Date).ToUniversalTime().ToString('O')}
$state|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $backup 'state.json') -Encoding UTF8
Copy-Item -LiteralPath $rollbackScript -Destination (Join-Path $installedRoot 'Uninstall-Newtest-UacPilot.ps1') -Force
Copy-Item -LiteralPath (Join-Path $root 'Uninstall-EpmPilot.ps1') -Destination (Join-Path $installedRoot 'Uninstall-EpmPilot.ps1') -Force
$ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action=New-ScheduledTaskAction -Execute $ps -Argument (
  '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+
  (Join-Path $installedRoot 'Uninstall-Newtest-UacPilot.ps1')+'" -Automatic'
)
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($RollbackMinutes)
Register-ScheduledTask -TaskName $rollbackTask -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force -ErrorAction Stop | Out-Null
try {
  if(Test-Path 'HKLM:\SOFTWARE\Classes\CLSID\{7464D2E2-202B-4546-953D-9AFCDA3201E6}'){
    if(!(Test-Path -LiteralPath $legacyTile)){throw 'Existing unknown UAC pilot registration; aborting upgrade.'}
    & $legacyTile
    }
  & $epmInstall -Executable $exe -ExpectedSha256 $checks['EPM_EXE_SHA256']
  & $tileInstall -DllPath $dll -ExpectedSha256 $checks['UAC_DLL_SHA256'] -RollbackMinutes $RollbackMinutes
  if((Get-Service Hi5CentralEpmPilot -ErrorAction Stop).Status -ne 'Running'){
    throw 'EPM Windows service did not start.'
  }
  $tileKey='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{7464D2E2-202B-4546-953D-9AFCDA3201E6}'
  if(!(Test-Path $tileKey)){throw 'Windows UAC tile was not registered.'}
  # Pilot-only shortcuts launch the five known operation adapters BEFORE the
  # actual Windows UAC screen. The adapter carries no arbitrary executable
  # or arguments and the broker always verifies their Microsoft signatures.
  $shortcuts=Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Hi5Central EPM Newtest'
  New-Item -Path $shortcuts -ItemType Directory -Force | Out-Null
  $shortcutShell=New-Object -ComObject WScript.Shell
  $target=Join-Path $env:ProgramFiles 'Hi5Central\EPM\Hi5CentralEpmPilot.exe'
  $actions=@(
    @{Code='notepad';Name='01 - Notepad (admin approval)'},
    @{Code='regedit';Name='02 - Registry Editor (admin approval)'},
    @{Code='services';Name='03 - Windows Services (admin approval)'},
    @{Code='powershell';Name='04 - PowerShell (admin approval)'},
    @{Code='msiexec-help';Name='05 - Windows Installer help (admin approval)'}
  )
  foreach($item in $actions) {
    $link=$shortcutShell.CreateShortcut((Join-Path $shortcuts ($item.Name+'.lnk')))
    $link.TargetPath=$target
    $link.Arguments='--managed-uac '+$item.Code
    $link.WorkingDirectory=Split-Path -Parent $target
    $link.Description='Hi5Central EPM: registered Windows action with RMM one-time approval'
    $link.Save()
  }
  Write-Host 'Five registered Hi5Central-managed Windows UAC shortcuts added to Start Menu.'
  Write-Host 'PASS: Newtest EPM service + native Windows UAC review tile installed.' -ForegroundColor Green
  Write-Host "Timed automatic rollback: $RollbackMinutes minutes." -ForegroundColor Cyan
  Write-Host 'Run Run-Newtest-UacCases.ps1 as the STANDARD Windows user; it starts the notification watcher.'
  Write-Warning 'Unmatched UAC requests remain review-only. Registered managed actions launch separately after explicit RMM approval; original UAC is cancelled.'
} catch {
  $errorText=$_.Exception.Message
  try {& (Join-Path $installedRoot 'Uninstall-Newtest-UacPilot.ps1')} catch {
    Write-Warning "Automatic rollback encountered an error: $($_.Exception.Message)"
  }
  throw "Unified EPM/UAC pilot installation failed and rollback was attempted: $errorText"
}
