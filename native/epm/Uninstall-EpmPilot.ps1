#requires -RunAsAdministrator
$ErrorActionPreference='Stop'
Remove-Item -Path 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\exefile\shell\Hi5CentralElevate' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\lnkfile\shell\Hi5CentralElevate' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'Hi5CentralEpmPilot' -ErrorAction SilentlyContinue
$svc=Get-Service Hi5CentralEpmPilot -ErrorAction SilentlyContinue
if($svc){Stop-Service Hi5CentralEpmPilot -Force -ErrorAction SilentlyContinue; & sc.exe delete Hi5CentralEpmPilot | Out-Null}
Write-Host 'EPM pilot shell integration removed. Original Company Portal and Self-Service Broker unchanged.'
