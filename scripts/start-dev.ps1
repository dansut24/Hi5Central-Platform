param(
  [string]$DevHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker was not found. Install/start Docker Desktop and reopen PowerShell.'
}

try {
  docker info *> $null
} catch {
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

if ([string]::IsNullOrWhiteSpace($DevHost)) {
  if (-not [string]::IsNullOrWhiteSpace($env:DEV_HOST) -and $env:DEV_HOST -ne 'localhost') {
    $DevHost = $env:DEV_HOST
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

Write-Host 'Hi5Central local URLs'
Write-Host ("  ITSM / Portal : http://{0}:3000" -f $DevHost)
Write-Host ("  RMM           : http://{0}:3002" -f $DevHost)
Write-Host ("  Admin         : http://{0}:3003" -f $DevHost)
Write-Host ("  API           : http://{0}:3001" -f $DevHost)
Write-Host ("  Local email   : http://{0}:8025" -f $DevHost)
Write-Host ''
Write-Host 'Use the same URLs from an iPhone connected to the same Wi-Fi.'
Write-Host 'Signup/verification emails are captured by Mailpit and are never sent externally.'
