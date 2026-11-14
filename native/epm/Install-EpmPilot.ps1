#requires -RunAsAdministrator
param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'EPM pilot executable not found' }
$actual = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256.Trim().ToUpperInvariant()) { throw 'EPM pilot binary SHA-256 does not match trusted CI artifact' }
$root = Join-Path $env:ProgramFiles 'Hi5Central\EPM'
New-Item -Path $root -ItemType Directory -Force | Out-Null
$target = Join-Path $root 'Hi5CentralEpmPilot.exe'
$svc = Get-Service Hi5CentralEpmPilot -ErrorAction SilentlyContinue
if ($svc) { Stop-Service Hi5CentralEpmPilot -Force -ErrorAction Stop }
Copy-Item -LiteralPath $Executable -Destination $target -Force
$imagePath = '"' + $target + '" --service'
if (-not $svc) {
  New-Service -Name 'Hi5CentralEpmPilot' -BinaryPathName $imagePath `
    -DisplayName 'Hi5Central Endpoint Privilege Management Pilot' `
    -StartupType Automatic -ErrorAction Stop | Out-Null
} else {
  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Hi5CentralEpmPilot' `
    -Name ImagePath -Value $imagePath -ErrorAction Stop
  Set-Service -Name 'Hi5CentralEpmPilot' -StartupType Automatic -ErrorAction Stop
}
$menu = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\exefile\shell\Hi5CentralElevate'
New-Item -Path $menu -Force | Out-Null
Set-Item -Path $menu -Value 'Run with Hi5Central admin'
Set-ItemProperty -Path $menu -Name 'Icon' -Value ('"' + $target + '"')
New-Item -Path ($menu + '\command') -Force | Out-Null
Set-Item -Path ($menu + '\command') -Value ('"' + $target + '" "%1"')
$startup = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
Set-ItemProperty -Path $startup -Name 'Hi5CentralEpmPilot' -Value ('"' + $target + '" --watch')
Start-Service Hi5CentralEpmPilot
Start-Sleep -Seconds 2
$service = Get-Service Hi5CentralEpmPilot
if ($service.Status -ne 'Running') { throw 'EPM broker did not start successfully' }
Write-Host 'Hi5Central EPM pilot installed. Right-click EXE → Show more options → Run with Hi5Central admin.' -ForegroundColor Green
Write-Host 'Log off/on to start the approval notification watcher as a standard user.'
Write-Host 'Only the Newtest Lenovo pilot will be allowed through the server-side gate.'
