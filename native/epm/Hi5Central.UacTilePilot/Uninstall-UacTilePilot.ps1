# Hi5Central UAC Credential UI pilot rollback.
# Intended for SYSTEM scheduled task or an existing elevated administrator shell.
# It NEVER changes built-in Windows credential providers, Agent or UAC policy.
$ErrorActionPreference='Stop'
$clsid='{7464D2E2-202B-4546-953D-9AFCDA3201E6}'
$provider="HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$clsid"
$com="HKLM:\SOFTWARE\Classes\CLSID\$clsid"
$task='Hi5Central-EPM-UacTilePilot-Rollback'

# Remove Credential UI discovery FIRST. Do not remove unrelated providers.
if(Test-Path $provider){Remove-Item -LiteralPath $provider -Recurse -Force}
if(Test-Path $com){Remove-Item -LiteralPath $com -Recurse -Force}

# A loaded DLL may stay mapped in consent.exe until that window closes.
# Leave its inert binary on disk instead of forcibly removing a loaded DLL.
try {
    $scheduled=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if($scheduled){Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction Stop}
} catch {
    Write-Warning 'Credential provider registry removed; the rollback task may need manual cleanup.'
}
if((Test-Path $provider) -or (Test-Path $com)){
    throw 'The Hi5Central UAC pilot registry entry remains. Manual recovery required.'
}
Write-Host 'PASS: Hi5Central UAC tile disabled and COM registration removed.' -ForegroundColor Green
Write-Host 'Normal Windows UAC and built-in credential providers remain unchanged.'
