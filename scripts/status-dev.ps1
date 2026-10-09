$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Test-Path '.env.local')) {
  Copy-Item '.env.example' '.env.local'
}

docker compose --env-file .env.local -f deploy/docker-compose.dev.yml ps
Write-Host ''
Write-Host 'Recent migration logs (including exit errors):'
docker compose --env-file .env.local -f deploy/docker-compose.dev.yml logs --tail 50 migrate

Write-Host ''
Write-Host 'Recent API logs:'
docker compose --env-file .env.local -f deploy/docker-compose.dev.yml logs --tail 80 api


Write-Host ''
Write-Host 'Recent frontend logs:'
foreach ($service in @('itsm', 'rmm', 'admin')) {
  Write-Host ''
  Write-Host ("--- {0} ---" -f $service)
  docker compose --env-file .env.local -f deploy/docker-compose.dev.yml logs --tail 30 $service
}
