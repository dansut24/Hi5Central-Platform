$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portalHash = '309BC60398A71868C6E7B4FF481C90FE97F9D0367EE4D99F93C68CC35F859625'
$hostHash = '42389534EAEA555CFBF01FE45D1ED0D1DD69850AC47D611D171E11F30DA4252E'
$portalUrl = 'https://downloads.hi5central.com/software/self-service/Hi5CentralAppPortal-' + $portalHash + '.exe'
$hostUrl = 'https://downloads.hi5central.com/software/self-service/Hi5CentralPatchHost-' + $hostHash + '.exe'
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
  state='installed'; version='0.2.1'; portalSha256=$portalHash
  patchHostSha256=$hostHash; portal=$portalState; patchHost=$patchState
  shortcut=$shortcut; installedAt=[DateTime]::UtcNow.ToString('o')
}
$record | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $root 'status.json') -Encoding UTF8
$record | ConvertTo-Json -Compress
