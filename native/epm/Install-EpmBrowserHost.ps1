#requires -RunAsAdministrator
<#
.SYNOPSIS
 Newtest pilot: install Hi5Central EPM browser-native messaging host and
 unpacked Edge/Chrome extension without changing EPM service or UAC.
#>
param(
    [Parameter(Mandatory=$true)][string]$HostExecutable,
    [Parameter(Mandatory=$true)][string]$ExtensionDirectory,
    [Parameter(Mandatory=$true)][string]$ExpectedHostSha256
)
$ErrorActionPreference='Stop'
$expectedId='mdablcgpimddfidkjilfglpcaolpopda'
$hostName='com.hi5central.epm_browser'
$root=Join-Path $env:ProgramFiles 'Hi5Central\EPM\BrowserBridge'
$extensionDest=Join-Path $root 'extension'
$hostDest=Join-Path $root 'Hi5CentralEpmBrowserHost.exe'
$manifestDest=Join-Path $root 'native-messaging-host.json'
$extManifest=Join-Path $ExtensionDirectory 'manifest.json'
$required=@('manifest.json','background.js','icon-128.png')
$broker=Join-Path $env:ProgramFiles 'Hi5Central\EPM\Hi5CentralEpmPilot.exe'

if(!(Test-Path -LiteralPath $broker -PathType Leaf)) {
    throw 'The existing Hi5Central EPM Windows client must be installed first.'
}
if(!(Test-Path -LiteralPath $HostExecutable -PathType Leaf)) {throw 'Browser bridge executable not found.'}
if((Get-FileHash -LiteralPath $HostExecutable -Algorithm SHA256).Hash -ne $ExpectedHostSha256.Trim().ToUpperInvariant()){
    throw 'Browser bridge CI binary SHA-256 does not match trusted package.'
}
foreach($filename in $required){
    if(!(Test-Path -LiteralPath (Join-Path $ExtensionDirectory $filename) -PathType Leaf)){
        throw "Extension file is missing: $filename"
    }
}
$extension=Get-Content -LiteralPath $extManifest -Raw | ConvertFrom-Json
if($extension.manifest_version -ne 3 -or
   ($extension.permissions -notcontains 'nativeMessaging') -or
   ($extension.permissions -notcontains 'downloads') -or
   ($extension.permissions -notcontains 'notifications')){
    throw 'Unexpected browser extension permissions or manifest version.'
}
# Developer key fixes the unpacked extension ID for both Edge/Chrome.
$public=[Convert]::FromBase64String([string]$extension.key)
$hasher=[Security.Cryptography.SHA256]::Create()
try { $sha=$hasher.ComputeHash($public) }
finally { $hasher.Dispose() }
$alphabet='abcdefghijklmnop'
$actualId=-join ($sha[0..15] | ForEach-Object {
    ([string]$alphabet[[int]($_ -shr 4)] + [string]$alphabet[[int]($_ -band 15)])
})
if($actualId -ne $expectedId){throw 'Unexpected browser extension identity. Nothing registered.'}

New-Item -ItemType Directory -Path $extensionDest -Force | Out-Null
Copy-Item -LiteralPath $HostExecutable -Destination $hostDest -Force
foreach($filename in $required){
    Copy-Item -LiteralPath (Join-Path $ExtensionDirectory $filename) -Destination (Join-Path $extensionDest $filename) -Force
}
$nativeManifest=[ordered]@{
    name=$hostName
    description='Hi5Central EPM standard-user download approval bridge (Newtest)'
    path=$hostDest
    type='stdio'
    allowed_origins=@("chrome-extension://$expectedId/")
}
$nativeManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestDest -Encoding UTF8
foreach($vendor in @('Microsoft\Edge','Google\Chrome')){
    $key="HKLM:\SOFTWARE\$vendor\NativeMessagingHosts\$hostName"
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestDest
}
Write-Host 'PASS: Hi5Central EPM browser bridge installed for Edge and Chrome.' -ForegroundColor Green
Write-Host "Extension ID: $expectedId"
Write-Host "Load unpacked extension folder: $extensionDest"
Write-Host 'No UAC setting, EPM service or Agent was modified.' -ForegroundColor Green
