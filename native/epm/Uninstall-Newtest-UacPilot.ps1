#requires -RunAsAdministrator
<#
Revert both parts of the Newtest EPM/UAC pilot without changing native
Windows login providers, Windows UAC policies, the main RMM Agent or App Portal.
Called manually or by an automatically scheduled SYSTEM rollback.
#>
param([switch]$Automatic)
$ErrorActionPreference='Stop'
$programRoot=Join-Path $env:ProgramFiles 'Hi5Central\EPM'
$bundleRoot=Join-Path $programRoot 'UacPilotBundle'
$backup=Join-Path $env:ProgramData 'Hi5Central\EPM\UacPilotPrevious'
$oldFile=Join-Path $backup 'Hi5CentralEpmPilot.previous.exe'
$statePath=Join-Path $backup 'state.json'
$task='Hi5Central-EPM-Newtest-UacPilot-Rollback'
$tileUninstall=Join-Path $programRoot 'UacTilePilot\Uninstall-UacTilePilot.ps1'
if(Test-Path -LiteralPath $tileUninstall) {
  & $tileUninstall
}
$tileKey='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{7464D2E2-202B-4546-953D-9AFCDA3201E6}'
if(Test-Path $tileKey) {
  throw 'UAC tile registry removal failed. No service restoration attempted.'
}
if(Test-Path -LiteralPath $statePath){
  $previous=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
  $service=Get-Service Hi5CentralEpmPilot -ErrorAction SilentlyContinue
  if($service){
    Stop-Service Hi5CentralEpmPilot -Force -ErrorAction SilentlyContinue
    $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20))
  }
  if($previous.serviceExisted) {
    if(!(Test-Path -LiteralPath $oldFile)){throw 'Original EPM broker backup missing; manual recovery required.'}
    Copy-Item -LiteralPath $oldFile -Destination (Join-Path $programRoot 'Hi5CentralEpmPilot.exe') -Force
    Start-Service Hi5CentralEpmPilot -ErrorAction Stop
    Write-Host 'PASS: Previous EPM Windows broker restored and started.'
  } else {
    $originalUninstall=Join-Path $bundleRoot 'Uninstall-EpmPilot.ps1'
    if(!(Test-Path -LiteralPath $originalUninstall)){
      throw 'Original EPM service uninstaller missing; manual recovery required.'
    }
    & $originalUninstall
    Write-Host 'PASS: Newtest EPM broker and shell integration removed.'
  }
} else {
  Write-Warning 'No previous EPM service state recorded; left existing EPM broker unchanged.'
}
# This entry was added only by the v6 pilot; do not leave a stale shell
# command pointing at a reverted or removed Windows broker.
Remove-Item -Path 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\lnkfile\shell\Hi5CentralElevate' -Recurse -Force -ErrorAction SilentlyContinue
$existingTask=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if($existingTask){
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction Stop
}
$pilotShortcuts=Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Hi5Central EPM Newtest'
if(Test-Path -LiteralPath $pilotShortcuts){
  Remove-Item -LiteralPath $pilotShortcuts -Recurse -Force -ErrorAction Stop
}
Write-Host ('PASS: Newtest UAC pilot rollback completed'+ $(if($Automatic){' (automatic).'}else{'.'}))
Write-Host 'Windows built-in password/PIN/Hello providers were not modified.'
