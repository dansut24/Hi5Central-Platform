# Build Chromium only on a dedicated high-capacity Windows runner.
# This never installs, registers or starts a remote host or touches Dell.
[CmdletBinding()]
param(
  [string]$SourceRoot=$env:H5C_CHROMIUM_SOURCE,
  [string]$OutputRoot=$env:H5C_CHROMIUM_OUTPUT
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Pin='0a502e844e10081c11c0a81eb40171466de252e4'
$SourceHash='b4438b5c7b9cddb47feefadac880fdf0005e95f4d66eb3e358f4e9f6d032cdbc'
$Rel='remoting/quickdesk/signaling/quickdesk_signal_strategy.cc'
$Patch=Join-Path (Split-Path $PSScriptRoot -Parent) 'third_party/quickdesk/patches/0002-native-host-preserve-authenticated-jingle.patch'
if([string]::IsNullOrWhiteSpace($SourceRoot) -or [string]::IsNullOrWhiteSpace($OutputRoot)){
  throw 'Configure H5C_CHROMIUM_SOURCE and H5C_CHROMIUM_OUTPUT on a dedicated Windows Chromium builder.'
}
$SourceRoot=(Resolve-Path -LiteralPath $SourceRoot).Path
$OutputRoot=[IO.Path]::GetFullPath($OutputRoot)
if($env:COMPUTERNAME -eq 'DESKTOP-2JHH2ON'){throw 'Refusing to build on the production Dell.'}
if(!(Test-Path (Join-Path $SourceRoot '.git'))){throw 'Chromium source has not been fetched/synced.'}
$actual=(& git -C $SourceRoot rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0 -or $actual -cne $Pin){throw "Expected pinned Chromium commit $Pin; got $actual"}
$dirty=@(& git -C $SourceRoot status --porcelain --untracked-files=no)
if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){throw 'Chromium checkout contains existing changes.'}
$source=Join-Path $SourceRoot ($Rel -replace '/', '\')
if((Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $SourceHash){
  throw 'Chromium native source does not match the audited pinned version.'
}
$mem=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB
$drive=[IO.Path]::GetPathRoot($SourceRoot).Substring(0,2)
$volume=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
$free=$volume.FreeSpace/1GB
Write-Host ('RAM_GB={0:N1};FREE_AFTER_SYNC_GB={1:N1}' -f $mem,$free)
if($mem -lt 24 -or $free -lt 80){
  throw 'Chromium requires a dedicated Windows builder: >=24 GB RAM, >=80 GB free after source sync.'
}
$gn=Get-Command gn.exe -ErrorAction SilentlyContinue
$ninja=Get-Command autoninja.bat -ErrorAction SilentlyContinue
$vswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if(!$gn -or !$ninja -or !(Test-Path $vswhere)){
  throw 'Chromium depot_tools/GN/autoninja or Visual Studio are unavailable.'
}
$vc=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if([string]::IsNullOrWhiteSpace($vc)){throw 'Visual Studio C++ tools unavailable.'}
if(!(Test-Path $Patch)){throw 'Pinned source patch missing.'}
$applied=$false
Push-Location $SourceRoot
try{
  & git apply --unidiff-zero --check $Patch
  if($LASTEXITCODE -ne 0){throw 'Pinned native patch does not apply.'}
  & git apply --unidiff-zero $Patch
  if($LASTEXITCODE -ne 0){throw 'Pinned native patch application failed.'}
  $applied=$true
  $patched=Get-Content $source -Raw
  if($patched -match 'converter_->ConvertFromJingle\(jingle_xml\)' -or
     $patched -notmatch 'std::string webrtc_json = stanza->Str\(\)'){
    throw 'Patched source does not preserve native Jingle/SDP.'
  }
  $dir='out/Hi5CentralChromium'
  $args='is_debug=false is_component_build=false symbol_level=0 target_os="win" target_cpu="x64" enable_remoting_host=true is_official_build=false'
  & $gn.Source gen $dir "--args=$args"
  if($LASTEXITCODE -ne 0){throw 'Chromium GN configuration failed.'}
  & $ninja.Source -C $dir quickdesk_host
  if($LASTEXITCODE -ne 0){throw 'Chromium native compilation failed.'}
  $out=Join-Path $SourceRoot 'out\Hi5CentralChromium'
  $exe=Join-Path $out 'quickdesk_host.exe'
  $icu=Join-Path $out 'icudtl.dat'
  $core=@('quickdesk_core.dll','remoting_core.dll') |
    ForEach-Object {Join-Path $out $_} |
    Where-Object {Test-Path $_} |Select-Object -First 1
  if(!(Test-Path $exe) -or !(Test-Path $icu) -or !$core){
    throw 'Native Chromium output incomplete: requires quickdesk_host.exe, core DLL and icudtl.dat.'
  }
  if(Test-Path $OutputRoot){throw 'Build staging output already exists; refusing overwrite.'}
  New-Item -Path $OutputRoot -ItemType Directory|Out-Null
  foreach($file in @($exe,$core,$icu)){
    Copy-Item $file $OutputRoot -ErrorAction Stop
  }
  Copy-Item (Join-Path $SourceRoot 'LICENSE') (Join-Path $OutputRoot 'CHROMIUM_LICENSE')
  $manifest=[ordered]@{
    name='Hi5Central experimental Chromium native host'
    pinned_source_commit=$Pin
    patch='0002-native-host-preserve-authenticated-jingle.patch'
    compiled=$true
    deployed=$false
    built_utc=[DateTime]::UtcNow.ToString('o')
    files=@(Get-ChildItem $OutputRoot -File|ForEach-Object {
      [ordered]@{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
  }
  $manifest|ConvertTo-Json -Depth 6|Set-Content (Join-Path $OutputRoot 'manifest.json') -Encoding UTF8
  Write-Output 'H5C_CHROMIUM_WINDOWS_HOST_COMPILED_AND_PACKAGED=YES'
}finally{
  if($applied){
    & git apply --unidiff-zero --reverse $Patch
    if($LASTEXITCODE -ne 0){Write-Warning 'Inspect Chromium checkout; native patch could not be restored.'}
  }
  Pop-Location
}
