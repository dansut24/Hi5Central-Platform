$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Test-Path '.env.local')) {
  Copy-Item '.env.example' '.env.local'
}

docker compose --env-file .env.local -f deploy/docker-compose.dev.yml down --remove-orphans
