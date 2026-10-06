$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Test-Path '.env.local')) {
  Copy-Item '.env.example' '.env.local'
}

docker compose --env-file .env.local -f deploy/docker-compose.dev.yml ps
Write-Host ''
Write-Host 'Recent API logs:'
docker compose --env-file .env.local -f deploy/docker-compose.dev.yml logs --tail 40 api
