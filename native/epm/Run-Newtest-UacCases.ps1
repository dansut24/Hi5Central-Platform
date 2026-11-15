<#
Interactive real-UAC smoke test for the Newtest Lenovo standard user.
This script does not alter registry, services, device policy or user groups.
Run in an unelevated Windows PowerShell window after installing the bundle.
For each prompt: More choices > Hi5Central EPM > enter a 20+ char reason
> Submit review. Return to RMM to Record review/Reject with a reason.
The native tile cannot grant a verified elevation: close/cancel native UAC.
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
if($CheckOnly){return}
$cases=@(
  [pscustomobject]@{Name='Notepad – explicit Run as administrator';Path="$env:WINDIR\System32\notepad.exe";Args=''},
  [pscustomobject]@{Name='Registry Editor – explicit Run as administrator';Path="$env:WINDIR\regedit.exe";Args=''},
  [pscustomobject]@{Name='Windows services console – elevated MMC';Path="$env:WINDIR\System32\mmc.exe";Args='services.msc'},
  [pscustomobject]@{Name='PowerShell – explicit Run as administrator';Path="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe";Args='-NoProfile -NoExit'},
  [pscustomobject]@{Name='Windows Installer – msiexec help only';Path="$env:WINDIR\System32\msiexec.exe";Args='/?'}
)
Write-Host ''
Write-Host 'Different prompts are tested one at a time. Choose More choices > Hi5Central EPM.'
Write-Host 'These requests can be REVIEWED/REJECTED, but cannot complete unknown native UAC elevation.'
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
    Write-Host 'Submit your reason in that separate verified-file flow; RMM may approve once.'
    Write-Host 'The user does not type a file path into the native UAC tile.'
    continue
  }
  $num=0
  if(-not [int]::TryParse($selected,[ref]$num) -or $num -lt 1 -or $num -gt $cases.Count){
    Write-Warning 'Choose a numbered case.';continue
  }
  $item=$cases[$num-1]
  if(!(Test-Path -LiteralPath $item.Path)){Write-Warning "Not installed: $($item.Path)";continue}
  Write-Host "Triggering a real Windows UAC prompt: $($item.Name)"
  Write-Host 'Choose Hi5Central EPM, enter a reason, then close/cancel the prompt after submitting.'
  try {
    if($item.Args){
      Start-Process -FilePath $item.Path -ArgumentList $item.Args -Verb RunAs -ErrorAction Stop
    } else {
      Start-Process -FilePath $item.Path -Verb RunAs -ErrorAction Stop
    }
    Write-Host 'A Windows process was started. If you used normal credentials, terminate the test instance.'
  } catch {
    if($_.Exception.Message -match 'cancel|cancell|1223'){
      Write-Host 'Windows UAC was cancelled (expected for review-only EPM).'
    } else {
      Write-Warning ('Windows returned: '+$_.Exception.Message)
    }
  }
  Read-Host 'After checking the RMM review and Windows notification, press Enter to continue' | Out-Null
}
Write-Host 'Newtest UAC smoke tests concluded. The pilot timed rollback remains active.'
