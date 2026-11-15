# Hi5Central EPM — UAC preferred tile and approval integration constraints
15 November 2026 | Newtest Lenovo only | original VPS ubuntu | do not touch EU.

## User acceptance
The real Windows UAC screen showed the Hi5Central EPM tile and editable
justification field with the Windows Administrator option under More choices.
User asked whether Hi5Central can be the default and whether the approval
workflow can be wired into the native prompt.

## Completed in this increment
- Source: native/epm/Hi5Central.UacTilePilot/UacTilePilot.cpp
- Change: in CPUS_CREDUI when one tile is offered, set pdwDefault=0
  instead of CREDENTIAL_PROVIDER_NO_DEFAULT. This nominates Hi5Central
  as preferred credential tile; Windows makes final selection.
- pbAutoLogonWithDefault remains FALSE. GetSerialization still always
  responds CPGSR_NO_CREDENTIAL_NOT_FINISHED and NEVER supplies credentials.
- No credential-provider filter, Windows password/PIN/Hello provider changes,
  UAC policy changes, default sign-in provider global policy, or account changes.
- CPUS_LOGON, CPUS_UNLOCK_WORKSTATION and CPUS_CHANGE_PASSWORD still denied.
- Restrictive CredUI flags still produce zero Hi5Central tiles and no default.
- Existing editable reason preview still LOCAL ONLY and never makes an RMM
  approval; status explicitly says no approval has been submitted.
- Windows CI run 43729287201, commit
  84ffc36d491a12661c1c8eeeb1775bf900a94c2b succeeded.
  Tests cover selected tile index=0, no auto-logon or credential output,
  restrictive modes, COM registration, scheduled rollback and clean uninstall.

## Downloadable research pilot, not installed on Lenovo yet
Bundle:
https://downloads.hi5central.com/epm/uac-default-tile-20261115/Hi5Central-EPM-UAC-Default-Tile-CI.zip
SHA256 F99DCD8D54B8E037A09CC8B1C5178353E217AD21F336A8F4FE941553A3109CD3

Native DLL SHA256:
147938D701D56C0AF6365D8AE2317A17A61B0AC0443A111D13F2EE688EA517D7

Checksum-pinned updater:
https://downloads.hi5central.com/epm/uac-default-tile-20261115/Install-Hi5Central-UacDefaultTile-20261115.ps1
SHA256 D9F1E63D28D5A1A11A2EB0F48EA495BB0DAD110042D7BF3FBB26598504B1C8F7

Same temporary CLSID and 25-minute SYSTEM auto-rollback as earlier pilot.
Uninstall earlier UacTilePilot before installing this one; never remove
another product's provider registry entries.

## What is NOT safely implemented
A real Windows UAC CPUS_CREDUI Credential Provider is an authentication
UI extension, not an app-authorization API. It is not documented to expose
an authenticated immutable EXE target path, command line, original
requesting user SID/session, or token allowing same consent.exe request to
resume after an external RMM decision. The header in Windows UAC may
show the app name, but reading HWND text or enumerating processes is
not proof that a particular original EXE is authorized. The provider's
GetSerialization must submit valid credentials; a Hi5Central technician's
approval is not a Windows admin password or a serialized token.

Therefore do NOT send a live approval or allow privileged launch from a
generic UAC tile without a verified target binding, and do NOT silently
supply reusable admin credentials, replace consent.exe, inject code into
AppInfo, alter EXE shell associations globally or disable secure desktop.

## Preferred safe integration design
1. Preserve existing working Win32 EPM approval broker, browser download
   bridge, SHA256/signature validation, original Downloads EXE,
   one-time SID/session/approval binding, normal installer GUI and audit.
2. Implement a pre-UAC *application launch interception* only through
   documented, user- or policy-installed integration points (Explorer
   context action, Edge/Chrome Native Messaging, Company Portal).
   Before UAC, the user companion has a verifiable file path that the
   service independently pins by hash and signer.
3. The companion can show a Hi5Central justification dialog and the
   existing RMM approval immediately. On approval, its notification
   relaunches that exact validated file with the qualified broker;
   no UAC credential submission is needed.
4. For arbitrary third-party UAC triggers such as Settings operations,
   process child installer elevations or launched-from-within-app, first
   research a documented provenance API with trustworthy target identity.
   Without one, native UAC must remain available as normal and users
   can choose existing EPM entry points.
5. Do not disable Microsoft credentials. More choices should remain a
   Windows-controlled alternate credential path, not a Hi5Central-owned
   username/password handler.
6. Avoid machine-wide DefaultCredentialProvider group policy. Its
   documented effects include sign-in Other user tile; default selection
   inside CredUI from provider's GetCredentialCount is less intrusive.

## Lenovo acceptance for preferred tile
1. Cancel native UAC. Keep an existing administrator PowerShell open.
2. Run installed UacTilePilot Uninstall-UacTilePilot.ps1 if still registered.
3. Download and verify SHA-256 of installer above; run from admin shell.
4. Under standard user run
   Start-Process "$env:WINDIR\\System32\\notepad.exe" -Verb RunAs
5. Observe whether Hi5Central is highlighted first and whether Microsoft
   Administrator remains available via More choices. Only this behavior
   is in scope, no real approval/elevation.
6. Cancel UAC and allow 25-minute automatic rollback or manually
   run the installed Uninstall-UacTilePilot.ps1.
7. Verify no pilot registry entry remains. The working EPM service and
   Edge browser bridge must remain intact.

## Microsoft documentation
- https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/nf-credentialprovider-icredentialprovider-getcredentialcount
- https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/nn-credentialprovider-icredentialproviderfilter
- https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works

## Continuation summary
User confirmed native UAC Hi5Central tile and reason input displayed inside
real UAC prompt alongside native Administrator credential. Preferred
CredUI tile added and verified Windows CI; checksum-pinned installer
published on original VPS, not run on Lenovo. Approval wiring remains
blocked on trustworthy original application identity and credential
serialization. Working EPM approval/launch, Edge bridge and main Agent
untouched, EU untouched. Next: test preferred selection and preserve
More choices; design secure pre-UAC trigger coverage without intercepting
Windows native consent.exe.
