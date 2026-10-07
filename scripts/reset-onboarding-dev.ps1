param(
  [ValidatePattern('^[a-z0-9-]+$')]
  [string]$TenantSlug = 'local',

  [ValidateSet('company','theme','delivery','groups','permissions','security','itsm','rmm','finish')]
  [string]$Step = 'company',

  [switch]$ClearAnswers
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Test-Path '.env.local')) {
  throw '.env.local was not found. Run .\scripts\start-dev.ps1 first.'
}

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Fallback
  )

  $prefix = "$Name="
  foreach ($line in Get-Content $Path) {
    if ($line.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $value = $line.Substring($prefix.Length).Trim()
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value
      }
    }
  }

  return $Fallback
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop is not running.'
}

$dbUser = Get-EnvValue -Path '.env.local' -Name 'POSTGRES_USER' -Fallback 'hi5central'
$dbName = Get-EnvValue -Path '.env.local' -Name 'POSTGRES_DB' -Fallback 'hi5central'

$answerExpression = if ($ClearAnswers) { "'{}'::jsonb" } else { 'onboarding_data' }

$sql = @"
BEGIN;

UPDATE tenant_settings ts
SET onboarding_step = '$Step',
    onboarding_completed_at = NULL,
    onboarding_data = $answerExpression,
    updated_at = now()
FROM tenants t
WHERE ts.tenant_id = t.id
  AND t.slug = '$TenantSlug';

DELETE FROM user_experience_preferences uep
WHERE uep.user_id IN (
  SELECT tm.user_id
  FROM tenant_memberships tm
  JOIN tenants t ON t.id = tm.tenant_id
  WHERE t.slug = '$TenantSlug'
);

UPDATE user_preferences up
SET preferences = '{}'::jsonb,
    first_login_completed_at = NULL,
    coachmarks_completed_at = NULL,
    getting_started_dismissed_at = NULL,
    updated_at = now()
FROM tenants t
WHERE up.tenant_id = t.id
  AND t.slug = '$TenantSlug';

COMMIT;
"@

if ($ClearAnswers) {
  $sql += @"

DELETE FROM tenant_delivery_settings tds
USING tenants t
WHERE tds.tenant_id = t.id
  AND t.slug = '$TenantSlug';
"@
}

Write-Host ''
Write-Host "Resetting Hi5Central local onboarding for tenant '$TenantSlug' to step '$Step' ..."
if ($ClearAnswers) {
  Write-Host 'Saved onboarding answers and Domain/email settings will also be cleared.'
} else {
  Write-Host 'Saved onboarding answers will be preserved.'
}

$sql | docker compose --env-file .env.local -f deploy/docker-compose.dev.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U $dbUser -d $dbName

if ($LASTEXITCODE -ne 0) {
  throw 'Could not reset local onboarding state.'
}

Write-Host ''
Write-Host 'Reset complete.'
Write-Host ''
Write-Host 'What was reset:'
Write-Host '  - Tenant onboarding completion marker'
Write-Host "  - Tenant onboarding step -> $Step"
Write-Host '  - Account-wide Personalise your workspace completion'
Write-Host '  - ITSM/RMM/Admin guided walkthrough completion'
Write-Host '  - Getting Started dismissal state'
Write-Host '  - Legacy per-tenant first-login markers'
Write-Host ''
Write-Host 'The secure login session remains valid. Refresh the browser.'
Write-Host 'The workspace will start in Light until the user chooses another appearance.'
