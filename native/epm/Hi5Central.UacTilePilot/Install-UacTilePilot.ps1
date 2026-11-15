#requires -RunAsAdministrator
<#
Hi5Central EPM — DISPOSABLE UAC CREDENTIAL UI RESEARCH PILOT.
Registers a DISPLAY-ONLY tile. It does NOT authenticate users, submit a
request, or elevate a process. The native Windows password/PIN/Hello providers
and Windows UAC policies are not changed.

Recovery:
  An automatic SYSTEM rollback task removes this tile after RollbackMinutes.
  The exact uninstall script is retained in %ProgramFiles%\Hi5Central\EPM\UacTilePilot.
  Keep an administrator PowerShell session open while performing the pilot.
#>
param(
  [Parameter(Mandatory=$true)][string]$DllPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [ValidateRange(10,45)][int]$RollbackMinutes=25
)
$ErrorActionPreference='Stop'
$clsid='{7464D2E2-202B-4546-953D-9AFCDA3201E6}'
$task='Hi5Central-EPM-UacTilePilot-Rollback'
$root=Join-Path $env:ProgramFiles 'Hi5Central\EPM\UacTilePilot'
$destination=Join-Path $root 'Hi5CentralUacTilePilot.dll'
$uninstall=Join-Path $root 'Uninstall-UacTilePilot.ps1'
$com="HKLM:\SOFTWARE\Classes\CLSID\$clsid"
$provider="HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$clsid"
$filter="HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Provider Filters\$clsid"

if(-not [Environment]::Is64BitProcess){
  throw 'Install from 64-bit elevated PowerShell; 32-bit registry redirection is not supported.'
}
if(-not (Test-Path -LiteralPath $DllPath -PathType Leaf)){
  throw 'Native UAC tile DLL not found. Nothing registered.'
}
$expected=$ExpectedSha256.Trim().ToUpperInvariant()
if($expected -notmatch '^[0-9A-F]{64}$'){
  throw 'Expected DLL SHA-256 must be a 64-character uppercase hexadecimal value.'
}
if((Get-FileHash -LiteralPath $DllPath -Algorithm SHA256).Hash -ne $expected){
  throw 'UAC tile DLL SHA-256 mismatch. Nothing registered.'
}
if((Test-Path $provider) -or (Test-Path $com) -or (Test-Path $filter)){
  throw 'The pilot CLSID is already registered. Run its uninstall first; no changes made.'
}
if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){
  throw 'Existing UAC pilot rollback task found; inspect before another installation.'
}
if((Get-Service -Name Hi5CentralEpmPilot -ErrorAction SilentlyContinue).Status -ne 'Running'){
  throw 'The existing Hi5Central EPM service must be Running, although this pilot never modifies it.'
}
$localUninstall=Join-Path $PSScriptRoot 'Uninstall-UacTilePilot.ps1'
if(-not (Test-Path -LiteralPath $localUninstall -PathType Leaf)){
  throw 'The companion rollback script must be present; no changes made.'
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
Copy-Item -LiteralPath $DllPath -Destination $destination -Force
Copy-Item -LiteralPath $localUninstall -Destination $uninstall -Force
if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected){
  throw 'Installed DLL checksum mismatch; no registry entry created.'
}

# Schedule automatic rollback BEFORE exposing the DLL to Credential UI.
$ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action=New-ScheduledTaskAction -Execute $ps -Argument (
  '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$uninstall+'"'
)
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($RollbackMinutes)
try {
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -User SYSTEM -RunLevel Highest -Force -ErrorAction Stop | Out-Null
  if(-not (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)){
    throw 'Automatic rollback task was not registered.'
  }

  # Native COM registration is additional only; never replace system CLSIDs.
  New-Item -Path "$com\InprocServer32" -Force | Out-Null
  Set-Item -Path "$com\InprocServer32" -Value $destination
  New-ItemProperty -Path "$com\InprocServer32" -Name ThreadingModel -Value Apartment -PropertyType String -Force | Out-Null
  New-Item -Path $provider -Force | Out-Null
  Set-Item -Path $provider -Value 'Hi5Central UAC Research Pilot (display only)'

  if(-not (Test-Path $provider) -or -not (Test-Path "$com\InprocServer32")){
    throw 'Credential UI registration verification failed.'
  }
  if(Test-Path $filter){
    throw 'Unexpected pilot credential provider filter registration.'
  }
}
catch {
  $original=$_
  Write-Warning ('Pilot installation failed: '+$original.Exception.Message)
  try { & $uninstall } catch { Write-Warning ('Rollback: '+$_.Exception.Message) }
  throw $original
}
Write-Host 'PASS: Display-only Hi5Central CPUS_CREDUI research tile registered.' -ForegroundColor Green
Write-Host "Automatic SYSTEM rollback in $RollbackMinutes minutes." -ForegroundColor Cyan
Write-Host "Rollback file: $uninstall"
Write-Host 'Keep your existing elevated PowerShell session open during testing.'
Write-Host 'Normal Windows sign-in, built-in providers, UAC policy and EPM service are unchanged.'
Write-Host 'The tile does NOT yet request approval or elevate applications.' -ForegroundColor Yellow
