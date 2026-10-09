param(
  [string]$DevHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function New-HexKey {
  param([int]$ByteCount = 32)

  $bytes = New-Object byte[] $ByteCount
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }

  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

function Ensure-EnvSecret {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Description
  )

  $lines = @(Get-Content $Path)
  $lineIndex = -1
  $currentValue = ''

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $prefix = "$Name="
    if ($lines[$i].StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $lineIndex = $i
      $currentValue = $lines[$i].Substring($prefix.Length).Trim()
      break
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($currentValue)) {
    return
  }

  $newValue = New-HexKey
  $newLine = "$Name=$newValue"

  if ($lineIndex -ge 0) {
    $lines[$lineIndex] = $newLine
  } else {
    $lines += $newLine
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, $lines, $utf8NoBom)
  Write-Host "Generated a persistent $Description in .env.local"
}

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
Ensure-EnvSecret -Path $envFile -Name 'MFA_ENCRYPTION_KEY' -Description 'local MFA encryption key'
Ensure-EnvSecret -Path $envFile -Name 'TENANT_SECRET_ENCRYPTION_KEY' -Description 'tenant secret encryption key'

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
$apiUrl = 'http://127.0.0.1:3001/live'
$lastApiError = ''
Write-Host "Waiting for the local API at $apiUrl ..."

# Use IPv4 explicitly. On some Windows hosts "localhost" resolves to IPv6,
# while Docker Desktop is only publishing the API on IPv4.
for ($attempt = 1; $attempt -le 30; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $apiUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $healthy = $true
      Write-Host ("  [PASS] API ready after {0} check(s)" -f $attempt)
      break
    }
    $lastApiError = "HTTP $($response.StatusCode)"
  } catch {
    $lastApiError = $_.Exception.Message
  }

  if ($attempt -eq 1 -or ($attempt % 5) -eq 0) {
    Write-Host ("  Waiting for API ({0}/30): {1}" -f $attempt, $lastApiError)
  }
  if ($attempt -lt 30) { Start-Sleep -Seconds 2 }
}

docker compose --env-file .env.local -f deploy/docker-compose.dev.yml ps

Write-Host ''
if (-not $healthy) {
  Write-Warning "API did not become reachable at $apiUrl. Last error: $lastApiError"
  Write-Host 'Recent migration and API logs:'
  docker compose --env-file .env.local -f deploy/docker-compose.dev.yml logs --tail 70 migrate api
  throw 'Local API startup failed. The database is preserved. Run .\scripts\status-dev.ps1 after checking the logs above.'
}

try {
  $databaseHealth = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 5
  if ($databaseHealth.StatusCode -eq 200) {
    Write-Host '  [PASS] API database and Redis health'
  }
} catch {
  Write-Warning "API is responding but PostgreSQL/Redis health failed: $($_.Exception.Message)"
  docker compose --env-file .env.local -f deploy/docker-compose.dev.yml logs --tail 50 api migrate
}

Write-Host ''
Write-Host 'Frontend readiness'
$frontendChecks = @(
  @{ Name = 'ITSM / Portal'; Url = 'http://127.0.0.1:3000' },
  @{ Name = 'Runtime config'; Url = 'http://localhost:3000/runtime-config.js' },
  @{ Name = 'RMM'; Url = 'http://127.0.0.1:3002' },
  @{ Name = 'Admin'; Url = 'http://127.0.0.1:3003' }
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
