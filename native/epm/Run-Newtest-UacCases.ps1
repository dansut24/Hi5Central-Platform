<#
Interactive real-UAC smoke test for the Newtest Lenovo standard user.
This script does not alter registry, services, device policy or user groups.
Run in an unelevated Windows PowerShell window after installing the bundle.
For each prompt: More choices > Hi5Central EPM > enter a 20+ char reason
> Submit review. Return to RMM to Record review/Reject with a reason.
For five trusted managed-action cases, it queues an exact action for RMM one-time approval.
The original Windows UAC is CANCELLED. An approved operation starts separately.
Other unknown Windows UAC prompts remain review-only.
#>
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$exe=Join-Path $env:ProgramFiles 'Hi5Central\EPM\Hi5CentralEpmPilot.exe'
if(!(Test-Path -LiteralPath $exe)){throw 'Combined EPM pilot is not installed.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  throw 'Run this test as the signed-in STANDARD user; elevated PowerShell hides the standard-user UAC workflow.'
}
$svc=Get-Service Hi5CentralEpmPilot -ErrorAction Stop
$clsid='{7464D2E2-202B-4546-953D-9AFCDA3201E6}'
$tileKey="HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$clsid"
Write-Host "Hi5Central EPM service: $($svc.Status)"
Write-Host "Native Hi5Central UAC tile: $(if(Test-Path $tileKey){'registered'}else{'NOT registered'})"
Write-Host 'RMM reviews: https://newtest-rmm.hi5central.com/elevation-requests'
if($svc.Status -ne 'Running' -or !(Test-Path $tileKey)){throw 'Pilot is incomplete; do not proceed.'}
# Idempotent per-user watcher (its own mutex prevents duplicate instances).
Start-Process -FilePath $exe -ArgumentList '--watch' -WindowStyle Hidden | Out-Null
Write-Host 'Windows notification watcher started for this user.'
$preflight=Join-Path $PSScriptRoot 'Test-Newtest-EpmBroker.ps1'
if(Test-Path -LiteralPath $preflight) {
  Write-Host 'Checking the actual EPM service named-pipe handshake before opening UAC...'
  & $preflight
  if(-not $?) {throw 'Hi5Central EPM local broker test failed; do not attempt the UAC prompts yet.'}
} else {
  Write-Warning 'Broker diagnostic is missing; run the updated unified Newtest build.'
}
if($CheckOnly){return}
$cases=@(
  [pscustomobject]@{Code='notepad';Name='Notepad – Windows managed elevated launch'},
  [pscustomobject]@{Code='regedit';Name='Registry Editor – Windows managed elevated launch'},
  [pscustomobject]@{Code='services';Name='Windows Services MMC – fixed services.msc arguments'},
  [pscustomobject]@{Code='powershell';Name='Windows PowerShell – fixed -NoProfile -NoExit arguments'},
  [pscustomobject]@{Code='msiexec-help';Name='Windows Installer – fixed /? help-only arguments'}
)
Write-Host ''
Write-Host 'Different prompts are tested one at a time. Choose More choices > Hi5Central EPM.'
Write-Host 'These five cases use a Hi5Central-registered operation BEFORE Windows UAC, then an RMM one-time exact command approval.'
Write-Host 'Unrelated UAC prompts remain REVIEW-ONLY and never elevate an unidentified operation.'
Write-Host 'Do not enter real administrator credentials as part of this smoke test.'
while($true){
  Write-Host ''
  for($i=0;$i -lt $cases.Count;$i++){Write-Host ("  {0}. {1}" -f ($i+1),$cases[$i].Name)}
  Write-Host '  6. Test a signed EXE via the Explorer right-click Hi5Central flow'
  Write-Host '  0. Exit'
  $selected=(Read-Host 'Select case').Trim()
  if($selected -eq '0'){break}
  if($selected -eq '6'){
    Write-Host 'In Explorer, right-click a trusted signed EXE > Show more options > Run with Hi5Central admin.'
    Write-Host 'Submit your reason and opt into automatic start in the verified-file flow; RMM can approve once.'
    Write-Host 'The user does not type a file path into the native UAC tile.'
    continue
  }
  $num=0
  if(-not [int]::TryParse($selected,[ref]$num) -or $num -lt 1 -or $num -gt $cases.Count){
    Write-Warning 'Choose a numbered case.';continue
  }
  $item=$cases[$num-1]
  Write-Host "Opening an authentic Windows UAC prompt for: $($item.Name)"
  Write-Host 'Choose More choices > Hi5Central EPM; enter reason; Submit.'
  Write-Host 'After the managed request is confirmed, CANCEL the original Windows UAC immediately.'
  Write-Host 'RMM will show the verified Windows program, immutable arguments and user. Approve once, then verify a process ID.'
  try {
    Start-Process -FilePath $exe -ArgumentList @('--managed-uac',$item.Code) -Wait -ErrorAction Stop
  } catch {Write-Warning ('Hi5Central managed launcher reported: '+$_.Exception.Message)}
  Read-Host 'After checking the RMM review and Windows notification, press Enter to continue' | Out-Null
}
Write-Host 'Newtest managed Windows UAC tests concluded. The pilot timed rollback remains active.'
