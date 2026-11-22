# Hi5Central RMM Agent 1.0.544 — VM-Lab readiness / explicit test mode.
# Read-only by default. Does NOT install an Agent or replace existing VM bridge.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$RmmDeviceId,
  [switch]$ActivateTestMode,
  [switch]$DeactivateTestMode
)
$ErrorActionPreference='Stop'
if($ActivateTestMode -and $DeactivateTestMode){throw 'Choose activation or deactivation, not both'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  throw 'VM-Lab preflight requires Administrator'
}
if($env:COMPUTERNAME -ieq 'DESKTOP-Q9LTF1M'){throw 'Refusing qualified Lenovo machine'}
if($RmmDeviceId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'){
  throw 'Expected exact RMM VM device UUID from Hi5Central Admin Portal'
}
$vmDevice=Join-Path $env:ProgramData 'Hi5Central\StreamCore\device.json'
$vmToken=Join-Path $env:ProgramData 'Hi5Central\StreamCore\host-token.txt'
if(-not(Test-Path -LiteralPath $vmDevice -PathType Leaf)){throw 'VM-Lab not enrolled in StreamCore'}
$device=Get-Content -LiteralPath $vmDevice -Raw | ConvertFrom-Json
if([string]$device.deviceId -cne 'vm-lab'){throw 'Not the enrolled vm-lab device'}
if(-not(Test-Path -LiteralPath $vmToken -PathType Leaf) -or
  (Get-Item -LiteralPath $vmToken).Length -lt 40){throw 'VM-Lab credential file absent'}
# Do not read or print the VM credential/token content.
if(-not(Test-Path -LiteralPath $PackageDirectory -PathType Container)){
  throw 'Extracted 544 artifact directory missing'
}
$manifestFile=Join-Path $PackageDirectory 'manifest.json'
if(-not(Test-Path -LiteralPath $manifestFile -PathType Leaf)){throw 'Build manifest missing'}
$m=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if([string]$m.version -cne '1.0.544' -or
   [string]$m.channel -cne 'vm-lab-test-only' -or
   [bool]$m.production_automatic_deployment -or
   -not [bool]$m.diagnostic_only){
  throw 'Not a VM-test-only Hi5Central RMM artifact'
}
$files=@(
 @('Hi5CentralAgentSetup-1.0.544-RMM-STREAMCORE-VMTEST.exe',$m.installer_sha256),
 @('Hi5CentralAgent-1.0.544-VMTEST.exe',$m.agent_sha256),
 @('Hi5StreamCore-RMM-Engine-v053-VMTEST.exe',$m.streamcore_sha256)
)
foreach($entry in $files){
 $p=Join-Path $PackageDirectory ([string]$entry[0])
 if(-not(Test-Path -LiteralPath $p -PathType Leaf) -or
  (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$entry[1]){
  throw ('Release integrity mismatch: '+[string]$entry[0])
 }
}
$service=Get-Service -Name Hi5CentralAgent -ErrorAction SilentlyContinue
if(-not $service){
 Write-Output 'VM_TEST_READINESS=AGENT_NOT_INSTALLED'
 Write-Output 'Install the unsigned 544 VMTEST installer after confirming VM RMM enrollment; no flags activated.'
 if($ActivateTestMode -or $DeactivateTestMode){throw 'VM RMM Agent is not installed'}
 return
}
$expectedExe=Join-Path $env:ProgramFiles 'Hi5Central\Agent\Hi5CentralAgent.exe'
if(-not(Test-Path -LiteralPath $expectedExe -PathType Leaf)){
 throw 'Cannot identify expected Hi5Central Agent binary location; refusing test mode'
}
$currentSha=(Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash.ToLowerInvariant()
if($currentSha -cne [string]$m.agent_sha256){
 throw 'Installed Agent differs from 1.0.544 VMTEST artifact; do not enable test mode'
}
# Disabling flags must be possible even if this build has been superseded.
if($DeactivateTestMode){
 foreach($name in @('HI5_RMM_STREAMCORE_ENGINE','HI5_RMM_STREAMCORE_CANARY',
  'HI5_RMM_STREAMCORE_VM_TEST_MODE','HI5_RMM_STREAMCORE_VM_TEST_HOSTNAME',
  'HI5_RMM_STREAMCORE_VM_TEST_DEVICE_ID','HI5_RMM_STREAMCORE_VM_LAB_ID')){
  [Environment]::SetEnvironmentVariable($name,$null,'Machine')
 }
 Restart-Service -Name 'Hi5CentralAgent' -ErrorAction Stop
 Write-Output 'VM_TEST_MODE=DEACTIVATED; Hi5CentralAgent restarted with original sender'
 return
}
Write-Output 'VM_TEST_READINESS=PASS'
Write-Output ('VM_TEST_HOST='+$env:COMPUTERNAME)
Write-Output ('VM_TEST_AGENT_SERVICE='+[string]$service.Status)
Write-Output 'VM_TEST_CODECS=VP8 initially; verify other codecs on VM before qualification'
if(-not $ActivateTestMode){return}
# Never adopt the Lenovo's codec approvals for a separate VM. A missing
# qualification starts VP8-only; additional codecs require measured VM tests.
$qualificationPath=Join-Path $env:ProgramData 'Hi5Central\StreamCore\v046\bin\codec-qualification-v046.json'
if(Test-Path -LiteralPath $qualificationPath -PathType Leaf){
 $existing=Get-Content -LiteralPath $qualificationPath -Raw|ConvertFrom-Json
 if([int]$existing.version -ne 46 -or [string]$existing.device -ine $env:COMPUTERNAME){
  throw 'Existing v046 codec qualification belongs to another machine; refusing overwrite'
 }
}else{
 $qualifiedDir=Split-Path -Path $qualificationPath -Parent
 New-Item -ItemType Directory -Path $qualifiedDir -Force -ErrorAction Stop|Out-Null
 $newQualification=[ordered]@{version=46;device=$env:COMPUTERNAME;browsers=[ordered]@{'ios-safari'=@();other=@()}}
 $newQualification|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $qualificationPath -Encoding UTF8 -ErrorAction Stop
 & icacls.exe $qualifiedDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Unable to secure VM codec qualification file directory'}
 Write-Output 'VM_TEST_CODEC_QUALIFICATION=VP8_ONLY'
}
# Activation is explicit, machine-admin-only and can be reversed by removing
# these five values and restarting the Agent. Never touch vm-lab bridge tasks.
$vars=[ordered]@{
 'HI5_RMM_STREAMCORE_ENGINE'='1'
 'HI5_RMM_STREAMCORE_CANARY'='1'
 'HI5_RMM_STREAMCORE_VM_TEST_MODE'='1'
 'HI5_RMM_STREAMCORE_VM_TEST_HOSTNAME'=$env:COMPUTERNAME
 'HI5_RMM_STREAMCORE_VM_TEST_DEVICE_ID'=$RmmDeviceId.ToLowerInvariant()
 'HI5_RMM_STREAMCORE_VM_LAB_ID'='vm-lab'
}
foreach($name in $vars.Keys){
 [Environment]::SetEnvironmentVariable($name,[string]$vars[$name],'Machine')
}
Restart-Service -Name 'Hi5CentralAgent' -ErrorAction Stop
Write-Output 'VM_TEST_MODE=ACTIVATED'
Write-Output 'RMM Agent restarted; VM-Lab bridge and Lenovo are untouched.'
