# Hi5Central EPM — native UAC tile reason-preview (15 November 2026)

## What the Lenovo test proved
The user showed the real Windows UAC credential screen for Notepad with the
Hi5Central EPM tile visible alongside the native Administrator account.
This confirms native CPUS_CREDUI tile presentation; not credential
serialization, actual approval submission or elevation from the same UAC.

## v2 implemented separately; Lenovo deployment pending
- Native credential-provider tile adds an editable business justification
  input (20–512 characters) and "Check justification (preview only)".
- The tile validates input and clearly says no RMM approval has been
  submitted. Text stays local; no network, passwords, signatures or
  privileged process creation occurs in the tile.
- CPUS_CREDUI only, no sign-in/unlock/password-change support, no
  password/credential submission, no built-in provider filter.
- 25-minute scheduled SYSTEM rollback and separate uninstall retained.

## Windows CI and download
- GitHub run 43728272817: Windows compile, native COM tests, reason
  validation and no-approval behavior, registry/rollback/uninstall PASS.
- Package:
  https://downloads.hi5central.com/epm/uac-reason-preview-20261115/Hi5Central-EPM-UAC-Reason-Preview-CI.zip
  SHA256 3901CFE87A9C96F7A85BE64B859F9D6CAD1482A758C44E05DA426195E14573D6
- Native DLL SHA256 86AFAE0B8F1892AA3F60897A1B52DC1E09EBF68CF4FCC2DFBD6721FC50907965
- Updater:
  https://downloads.hi5central.com/epm/uac-reason-preview-20261115/Install-Hi5Central-UacReasonPreview-20261115.ps1
  SHA256 61C4A311942855AF4E9D72A7984C241C552C42142FC4512AFF807D62CBC37C79

## Lenovo v2 validation
1. Cancel any active UAC prompt. Keep an existing elevated
   PowerShell open for recovery.
2. Remove any registered v1 tile through its existing standalone
   Uninstall-UacTilePilot.ps1 script before installing v2.
3. Download and checksum-verify the v2 updater; run it as admin.
4. As standard user open a UAC prompt using:
   Start-Process "$env:WINDIR\System32\notepad.exe" -Verb RunAs
5. Select the Hi5Central tile; enter a 20+ character justification;
   click Check justification (preview only). It must NOT submit to RMM.
6. Cancel Windows UAC; uninstall the tile or let its 25-minute
   SYSTEM rollback remove the test registry entries. Verify the built-in
   administrator authentication choice remains available.

## Security/feasibility gate
Windows Credential Providers are for collecting/serializing legitimate
credentials. The documented CPUS_CREDUI API does not supply a trusted,
immutable original target EXE pathname to this provider. An RMM approval
is not a Windows administrator credential. We cannot treat the visible
UAC header text or an arbitrary process as trustworthy authorization.
The existing Hi5Central EPM broker already supports hash- and
signer-bound one-use per-file elevated launch, with standard user
request, technician approval, Windows notifications and audit.
Do not implement same-UAC resumption, token injection or a generic
administrator privilege grant without supported, secure target binding.

## Continuation summary
User confirmed the display-only v1 tile appeared inside genuine Notepad
UAC credential screen while native Administrator option remained.
v2 justification preview implemented and CI-green but not installed on
Lenovo. Next: test preview field and automatic rollback; investigate a
trusted per-file launch target handoff, then decide whether the full
UAC-based approval workflow is feasible. Preserve working EPM Agent,
browser bridge, original VPS ubuntu. Do not touch EU.
