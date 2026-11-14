$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portalHash = 'FF08C02ACBD92A4CB9F1248BEEAFC4EB652CF0D92F745553EE90C1E0F17683CC'
$hostHash = '42389534EAEA555CFBF01FE45D1ED0D1DD69850AC47D611D171E11F30DA4252E'
$brokerHash = '921492D9884C471E0021F81E85584EC0E0CED80B3C51B98A46D1981AB748E193'
$portalUrl = 'https://downloads.hi5central.com/software/self-service/Hi5CentralAppPortal-' + $portalHash + '.exe'
$hostUrl = 'https://downloads.hi5central.com/software/self-service/Hi5CentralPatchHost-' + $hostHash + '.exe'
$brokerUrl = 'https://downloads.hi5central.com/software/self-service/Hi5CentralSelfServiceBroker-' + $brokerHash + '.exe'
$root = Join-Path $env:ProgramData 'Hi5Central\Agent\SelfService'
New-Item -ItemType Directory -Force -Path $root | Out-Null
# A disable policy wins over any older, in-flight reconciliation task.
$disabledMarker = Join-Path $root 'disabled.txt'
if (Test-Path -LiteralPath $disabledMarker) { throw 'Self Service is disabled for this device' }

$service = Get-CimInstance Win32_Service -Filter "Name='Hi5CentralAgent'"
if (-not $service) { throw 'Hi5Central Agent service not found' }
$servicePath = [string]$service.PathName
if ($servicePath -match '^"([^"]+)"') {
  $serviceExe = $Matches[1]
} else {
  $serviceExe = ($servicePath -split '\s+--')[0].Trim('"')
}
$agentDir = Split-Path -Parent $serviceExe
$expectedDir = Join-Path $env:ProgramFiles 'Hi5Central\Agent'
if ([IO.Path]::GetFullPath($agentDir).TrimEnd('\') -ine [IO.Path]::GetFullPath($expectedDir).TrimEnd('\')) {
  throw 'Unexpected Agent installation directory; refusing to modify another directory'
}
if (-not (Test-Path -LiteralPath (Join-Path $agentDir 'Hi5CentralAgent.exe'))) {
  throw 'Expected Agent executable is missing'
}
function Install-PinnedFile([string]$Url,[string]$Hash,[string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Hash) { return 'already_current' }
  }
  $stage = Join-Path $root ($Hash + '.download')
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $stage -UseBasicParsing -TimeoutSec 150
    if ((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $Hash) {
      throw 'Downloaded artifact SHA-256 mismatch'
    }
    if (Test-Path -LiteralPath $Destination) {
      $processName = [IO.Path]::GetFileNameWithoutExtension($Destination)
      if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
        throw "File $processName is in use; retry after process exits"
      }
      $backup = Join-Path $root ([IO.Path]::GetFileName($Destination) + '.before-self-service.bak')
      Copy-Item -LiteralPath $Destination -Destination $backup -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $disabledMarker) { throw 'Self Service disabled during download' }
    Copy-Item -LiteralPath $stage -Destination $Destination -Force -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Hash) {
      throw 'Installed artifact SHA-256 mismatch'
    }
    return 'updated'
  } finally { Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue }
}
$hostDest = Join-Path $agentDir 'Hi5CentralPatchHost.exe'
$portalDest = Join-Path $agentDir 'Hi5CentralAppPortal.exe'
$patchState = Install-PinnedFile $hostUrl $hostHash $hostDest
# The SYSTEM broker is deliberately independent of Hi5CentralAgent. Its binary
# and service live in a separate Program Files subtree.
$brokerDir = Join-Path $env:ProgramFiles 'Hi5Central\SelfServiceBroker'
New-Item -ItemType Directory -Force -Path $brokerDir | Out-Null
$brokerDest = Join-Path $brokerDir 'Hi5CentralSelfServiceBroker.exe'
$brokerName = 'Hi5CentralSelfServiceBroker'
$brokerSvc = Get-CimInstance Win32_Service -Filter "Name='$brokerName'" -ErrorAction SilentlyContinue
# Windows will lock a running service executable. Only the independent
# broker is stopped for its own SHA-pinned upgrade; NEVER the RMM Agent.
if ($brokerSvc -and $brokerSvc.State -eq 'Running' -and (Test-Path -LiteralPath $brokerDest) -and ((Get-FileHash -LiteralPath $brokerDest -Algorithm SHA256).Hash -ne $brokerHash)) {
  if (Get-Process -Name 'Hi5CentralPatchHost' -ErrorAction SilentlyContinue) {
    throw 'App installation is active; defer broker upgrade to next reconciliation'
  }
  Stop-Service -Name $brokerName -ErrorAction Stop
  (Get-Service -Name $brokerName).WaitForStatus('Stopped',[timespan]::FromSeconds(30))
}
$brokerFileState = Install-PinnedFile $brokerUrl $brokerHash $brokerDest
if ($brokerSvc) {
  $expected = '"'+$brokerDest+'"'
  if (-not (($brokerSvc.PathName -eq $expected) -or ($brokerSvc.PathName -eq $brokerDest))) {
    throw 'Independent broker service executable path mismatch'
  }
} else {
  $quoted = '"'+$brokerDest+'"'
  New-Service -Name $brokerName -BinaryPathName $quoted -StartupType Automatic -DisplayName 'Hi5Central Self Service Broker' -ErrorAction Stop | Out-Null
}
& sc.exe failure $brokerName reset= 3600 actions= 'restart/60000/restart/300000/restart/900000' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Independent broker service recovery setup failed' }
$brokerSvc = Get-Service -Name $brokerName -ErrorAction Stop
if ($brokerSvc.Status -ne 'Running') {
  Start-Service -Name $brokerName -ErrorAction Stop
  $brokerSvc.WaitForStatus('Running',[timespan]::FromSeconds(25))
}
if ((Get-FileHash -LiteralPath $brokerDest -Algorithm SHA256).Hash -ne $brokerHash) {
  throw 'Independent broker installed SHA256 mismatch'
}
# Install broker first. An opened Self Service GUI may lock its EXE, but the
# separate broker must remain running and can serve old GUI until next retry.

# Update the user-facing UI after the independent service has been verified.
# A locked GUI must never block the independent service installation.
$portalState = Install-PinnedFile $portalUrl $portalHash $portalDest
$startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
$shortcut = Join-Path $startMenu 'Hi5Central Self Service.lnk'
$wsh = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($shortcut)
$link.TargetPath = $portalDest
$link.WorkingDirectory = $agentDir
$link.IconLocation = $portalDest + ',0'
$link.Description = 'Hi5Central company applications and self-service'
if (Test-Path -LiteralPath $disabledMarker) { throw 'Self Service disabled before shortcut creation' }
$link.Save()
if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Start Menu shortcut missing' }
$record = [pscustomobject]@{
  state='installed'; version='0.2.3'; portalSha256=$portalHash
  patchHostSha256=$hostHash; brokerSha256=$brokerHash; portal=$portalState; patchHost=$patchState; broker=$brokerFileState
  shortcut=$shortcut; installedAt=[DateTime]::UtcNow.ToString('o')
}
$record | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $root 'status.json') -Encoding UTF8
$record | ConvertTo-Json -Compress
