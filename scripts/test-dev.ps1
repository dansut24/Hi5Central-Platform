param(
  [string]$HostName = 'localhost'
)

$ErrorActionPreference = 'Stop'

$checks = @(
  @{ Name = 'API live'; Url = "http://$($HostName):3001/live"; Json = $true },
  @{ Name = 'API health'; Url = "http://$($HostName):3001/health"; Json = $true },
  @{ Name = 'Deployment config'; Url = "http://$($HostName):3001/api/v1/system/deployment"; Json = $true },
  @{ Name = 'Capabilities'; Url = "http://$($HostName):3001/api/v1/system/capabilities"; Json = $true },
  @{ Name = 'Edition'; Url = "http://$($HostName):3001/api/v1/system/edition"; Json = $true },
  @{ Name = 'ITSM / Portal'; Url = "http://$($HostName):3000"; Json = $false },
  @{ Name = 'Runtime config JS'; Url = "http://$($HostName):3000/runtime-config.js"; Json = $false },
  @{ Name = 'ITSM API proxy'; Url = "http://$($HostName):3000/api/v1/system/deployment"; Json = $true },
  @{ Name = 'RMM'; Url = "http://$($HostName):3002"; Json = $false },
  @{ Name = 'RMM API proxy'; Url = "http://$($HostName):3002/api/v1/system/deployment"; Json = $true },
  @{ Name = 'Admin'; Url = "http://$($HostName):3003"; Json = $false },
  @{ Name = 'Admin API proxy'; Url = "http://$($HostName):3003/api/v1/system/deployment"; Json = $true },
  @{ Name = 'Mailpit'; Url = "http://$($HostName):8025"; Json = $false }
)

$failures = @()

Write-Host ''
Write-Host "Hi5Central local smoke test: $HostName"
Write-Host ''

foreach ($check in $checks) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $check.Url -TimeoutSec 8
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
      throw "HTTP $($response.StatusCode)"
    }

    if ($check.Json) {
      $null = $response.Content | ConvertFrom-Json
    }

    Write-Host ("[PASS] {0} - HTTP {1}" -f $check.Name, $response.StatusCode)
  } catch {
    $failures += $check.Name
    Write-Host ("[FAIL] {0} - {1}" -f $check.Name, $_.Exception.Message)
  }
}

try {
  $deployment = Invoke-RestMethod -Uri "http://$($HostName):3001/api/v1/system/deployment" -TimeoutSec 8
  Write-Host ''
  Write-Host 'Runtime'
  Write-Host ("  Deployment mode : {0}" -f $deployment.deploymentMode)
  Write-Host ("  Tenancy mode    : {0}" -f $deployment.tenancyMode)
  Write-Host ("  App URL         : {0}" -f $deployment.appUrl)
  Write-Host ("  API URL         : {0}" -f $deployment.apiUrl)
  Write-Host ("  RMM URL         : {0}" -f $deployment.rmmUrl)
  Write-Host ("  Admin URL       : {0}" -f $deployment.adminUrl)
} catch {
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host ("Smoke test failed: {0}" -f ($failures -join ', '))
  exit 1
}

$runtimeConfig = Invoke-WebRequest -UseBasicParsing -Uri "http://$($HostName):3000/runtime-config.js" -TimeoutSec 8
if ($runtimeConfig.Content -notmatch '__HI5_API_BASE__' -or $runtimeConfig.Content -notmatch ':3000') {
  Write-Host '[FAIL] Runtime config does not expose the same-origin ITSM API URL.'
  exit 1
}
Write-Host '[PASS] Runtime config exposes the same-origin ITSM API URL.'
Write-Host ''
Write-Host 'All local Hi5Central smoke tests passed.'
exit 0
