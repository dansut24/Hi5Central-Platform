param(
  [string]$DevHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker was not found. Install/start Docker Desktop and reopen PowerShell.'
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop is installed but the Docker engine is not running.'
}

docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Compose v2 is required. Run this script from Windows PowerShell where Docker Desktop exposes docker compose.'
}

if (-not (Test-Path '.env.local')) {
  Copy-Item '.env.example' '.env.local'
  Write-Host 'Created .env.local from .env.example'
}

$envFile = Join-Path $repoRoot '.env.local'
$envLines = @(Get-Content $envFile)
$keyLineIndex = -1

for ($i = 0; $i -lt $envLines.Count; $i++) {
  if ($envLines[$i] -match '^MFA_ENCRYPTION_KEY=(.*)$') {
    $keyLineIndex = $i
    break
  }
}

$currentMfaKey = ''
if ($keyLineIndex -ge 0) {
  $currentMfaKey = ($envLines[$keyLineIndex] -replace '^MFA_ENCRYPTION_KEY=', '').Trim()
}

if ([string]::IsNullOrWhiteSpace($currentMfaKey)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }

  $currentMfaKey = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $newKeyLine = "MFA_ENCRYPTION_KEY=$currentMfaKey"

  if ($keyLineIndex -ge 0) {
    $envLines[$keyLineIndex] = $newKeyLine
  } else {
    $envLines += $newKeyLine
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($envFile, $envLines, $utf8NoBom)
  Write-Host 'Generated a persistent local MFA encryption key in .env.local'
}

if ([string]::IsNullOrWhiteSpace($DevHost)) {
  $configuredDevHost = [Environment]::GetEnvironmentVariable('DEV_HOST')

  if ((-not [string]::IsNullOrWhiteSpace($configuredDevHost)) -and ($configuredDevHost -ne 'localhost')) {
    $DevHost = $configuredDevHost
  } else {
    $network = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
      Where-Object {
        $_.NetAdapter.Status -eq 'Up' -and
        $_.IPv4DefaultGateway -and
        $_.IPv4Address -and
        $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback'
      } |
      Select-Object -First 1

    if ($network -and $network.IPv4Address.IPAddress) {
      $DevHost = $network.IPv4Address.IPAddress
    } else {
      $DevHost = 'localhost'
    }
  }
}

$env:DEV_HOST = $DevHost

Write-Host ''
Write-Host "Starting Hi5Central local development on $DevHost ..."

docker compose --env-file .env.local -f deploy/docker-compose.dev.yml up -d
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Compose failed to start the local stack.'
}

$healthy = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3001/live' -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $healthy = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}

docker compose --env-file .env.local -f deploy/docker-compose.dev.yml ps

Write-Host ''
if (-not $healthy) {
  Write-Warning 'The containers started, but the API health endpoint did not become ready. Run .\scripts\status-dev.ps1 and inspect the API/migrate logs.'
}

Write-Host ''
Write-Host 'Frontend readiness'
$frontendChecks = @(
  @{ Name = 'ITSM / Portal'; Url = 'http://localhost:3000' },
  @{ Name = 'Runtime config'; Url = 'http://localhost:3000/runtime-config.js' },
  @{ Name = 'RMM'; Url = 'http://localhost:3002' },
  @{ Name = 'Admin'; Url = 'http://localhost:3003' }
)

foreach ($check in $frontendChecks) {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $check.Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  if ($ready) {
    Write-Host ("  [PASS] {0}" -f $check.Name)
  } else {
    Write-Warning ("  [FAIL] {0}. Run .\scripts\status-dev.ps1 for container logs." -f $check.Name)
  }
}

Write-Host ''
Write-Host 'Hi5Central local URLs'
Write-Host ("  ITSM / Portal : http://{0}:3000" -f $DevHost)
Write-Host ("  RMM           : http://{0}:3002" -f $DevHost)
Write-Host ("  Admin         : http://{0}:3003" -f $DevHost)
Write-Host ("  API           : http://{0}:3001" -f $DevHost)
Write-Host ("  Local email   : http://{0}:8025" -f $DevHost)
Write-Host ''
Write-Host 'Use the same URLs from an iPhone connected to the same Wi-Fi.'
Write-Host 'Signup/verification emails are captured by Mailpit and are never sent externally.'
