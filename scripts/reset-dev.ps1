$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Test-Path '.env.local')) {
  Copy-Item '.env.example' '.env.local'
}

Write-Host 'Removing the local Hi5Central containers and development data volumes...'
docker compose --env-file .env.local -f deploy/docker-compose.dev.yml down --volumes --remove-orphans

if ($LASTEXITCODE -ne 0) {
  throw 'Could not reset the local Docker stack.'
}

& (Join-Path $PSScriptRoot 'start-dev.ps1')
