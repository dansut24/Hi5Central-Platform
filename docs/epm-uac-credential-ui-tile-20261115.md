# Hi5Central EPM — native Windows UAC Credential UI tile pilot
15 November 2026 | Newtest Lenovo only | NOT production-qualified

## Current state and exact scope
User confirmed the Edge browser bridge works perfectly and approved
testing a native UAC proof of concept on the Lenovo, which can be reset.
The working Notepad++ EPM elevation, Agent and Company Portal remain intact.
Do not modify the EU server.

The new pilot is DISPLAY ONLY. It cannot authenticate, submit an approval,
pause/resume a native UAC prompt, or elevate a process. Its sole test is
whether Windows displays a Hi5Central credential tile inside native UAC.

## Implemented
- x64 native COM provider with CLSID {7464D2E2-202B-4546-953D-9AFCDA3201E6}.
- Accepts CPUS_CREDUI only; rejects CPUS_LOGON, CPUS_UNLOCK_WORKSTATION,
  and CPUS_CHANGE_PASSWORD; no credential provider filter.
- Non-default tile titled "Hi5Central EPM" with a safe explanatory link.
- Does not collect credentials, expose a password field, serialize a token,
  automatically sign in or enable elevation.
- Zero tiles for CREDUIWIN_GENERIC, CREDUIWIN_IN_CRED_ONLY,
  or CREDUIWIN_AUTHPACKAGE_ONLY; therefore the real Windows UAC prompt may
  suppress the pilot depending on its flags or device policy.
- Installer adds only pilot CLSID COM registration and pilot entry under
  HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers.
- Automatic SYSTEM rollback scheduled BEFORE registry changes, after
  25 minutes. Uninstall removes only the pilot entries and task.
- No UAC settings, Windows password/PIN/Hello providers, Agent, EPM service,
  self-service broker, Edge extension or other tenants changed.

## Windows CI and distribution
GitHub Actions run 43724359380 passed (commit
52f56d36da145f1b571edd741747df19fc49bbfe).
Native COM tests directly instantiate the DLL and verify UAC-only scenario,
field descriptors, no password/submission fields, no credential serialization,
no auto logon, and correct COM lifetime. Windows CI also tested isolated
COM/credential provider registration and non-destructive uninstall, including
the SYSTEM rollback scheduled task. CI did not open a live secure UAC prompt.

CI bundle:
https://downloads.hi5central.com/epm/uac-tile-20261115/Hi5Central-EPM-UAC-Tile-CI.zip
SHA256 ACBF02ED0E504A8C5E9F842D11082E2AF8580EEDD40A24B278B473DB12ACAACE
DLL SHA256 BE384649F0C8B0104C9582FA5797F8B62940A602D3289E5ED8E895B504DC8794

Checksum-pinned Lenovo installer:
https://downloads.hi5central.com/epm/uac-tile-20261115/Install-Hi5Central-UacTilePilot-20261115.ps1
SHA256 54DAB9ED7FA8D8B0E74A1D46AB8DF8D8FC91548ABEEC0A8AC58876D829B591BD

## Lenovo test
1. Keep an already elevated administrator PowerShell window OPEN for recovery.
2. Download wrapper in Admin PowerShell; verify its SHA256 above before running.
   It registers only this display-only pilot and arms 25-minute SYSTEM rollback.
3. In standard-user PowerShell run:
   Start-Process "$env:WINDIR\System32\notepad.exe" -Verb RunAs
4. Inspect the normal UAC credential screen for a Hi5Central EPM tile,
   possibly under More choices. Do NOT enter credentials in this pilot.
   Screenshot the native UAC screen if possible, then CANCEL.
5. Confirm built-in Microsoft credential options remain accessible.
6. Optional manual rollback from existing Admin PowerShell:
   & "$env:ProgramFiles\Hi5Central\EPM\UacTilePilot\Uninstall-UacTilePilot.ps1"
   Otherwise wait for automatic rollback after 25 minutes.
7. Check pilot CLSID is no longer registered when rollback completes.

## Future work and limits
The first test checks TILE VISIBILITY only. Microsoft requires credential
providers to serialize genuine authentication credentials for native UAC
submission. An RMM approval is not an admin password. UAC may not supply
the exact originally launched file identity or a way to resume its
suspended prompt via a documented Windows API. Until proven, do not promise
same-prompt resume or add generic administrator credential injection.
If tile appears, research a secure handoff to the EPM service plus
a separately verified completion path, preserving per-file SHA/signature,
requester SID/session, one-time approvals and safe fallback.
Keep the tested Run with Hi5Central admin and Edge bridge available.

References:
https://learn.microsoft.com/en-us/windows/desktop/api/credentialprovider/ne-credentialprovider-credential_provider_usage_scenario
https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/nf-credentialprovider-icredentialprovidercredential-getserialization
https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows

Chat continuation summary: successful native EPM Notepad++ install and Edge
bridge; new UAC CPUS_CREDUI-only display tile built, CI green, published on
original VPS. User approved Lenovo pilot; not installed there yet.
Next task: run checksum-verified installer, inspect native UAC tile,
confirm normal Windows provider remains, rollback in 25 minutes.
