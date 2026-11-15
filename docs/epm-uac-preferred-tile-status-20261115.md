# Hi5Central EPM — native UAC preferred tile status (15 November 2026)

## Result
Hi5Central UAC CPUS_CREDUI tile with local-only justification was already
shown and tested on the Newtest Lenovo. Its real credential-tile appearance
and input work. The newly implemented preference code now requests tile
index 0 as the preferred default when the CredUI scenario is supported.
Windows itself chooses the final default among all providers, so the
preference must still be checked in a live Lenovo UAC prompt.

## Current implementation
- Source: native/epm/Hi5Central.UacTilePilot/UacTilePilot.cpp
- Preferred credential: GetCredentialCount returns count=1,
  defaultCredential=0, autoLogon=FALSE for supported CPUS_CREDUI.
- For unsupported/restrictive CredUI contexts, count=0 and
  defaultCredential=CREDENTIAL_PROVIDER_NO_DEFAULT, no auto-logon.
- CPUS_LOGON/UNLOCK_WORKSTATION/CHANGE_PASSWORD remain unsupported.
- Built-in Windows credential providers are never filtered or disabled,
  preserving the administrator password recovery route and More choices
  where Windows offers it.
- Justification is local preview only: no RMM submission and no privileged
  launch is triggered by the tile. GetSerialization returns
  CPGSR_NO_CREDENTIAL_NOT_FINISHED.
- No proof exists of resuming the original UAC action after an external
  approval. Windows credential provider APIs don't supply a reliable,
  signed, immutable target EXE path; the RMM approval is not a Windows
  credential. Do not associate a UAC request with a process selected by
  window text/title alone.

## Validation
Windows CI run 43729287201, commit
84ffc36d491a12661c1c8eeeb1775bf900a94c2b: SUCCESS.
Native COM tests verify preferred tile index 0, no auto-logon, restrictive
scenario fallback, no credentials, reason field, DLL lifetime, and
registration/uninstall with a SYSTEM auto-rollback task.

Latest package on original VPS (not installed on Lenovo):
- ZIP:
  https://downloads.hi5central.com/epm/uac-preferred-20261115/Hi5Central-EPM-UAC-Preferred-Tile-CI.zip
- ZIP SHA256: F99DCD8D54B8E037A09CC8B1C5178353E217AD21F336A8F4FE941553A3109CD3
- DLL SHA256: 147938D701D56C0AF6365D8AE2317A17A61B0AC0443A111D13F2EE688EA517D7
- Windows updater:
  https://downloads.hi5central.com/epm/uac-preferred-20261115/Install-Hi5Central-UacPreferredTile-20261115.ps1
- Updater SHA256: 7CB231ABEBB8CEF423963306E6978C876E4CEE153A62BCD1366D3A901EF05F2B
- Updater uses existing checksum-gated DLL installer, with 25-minute
  scheduled SYSTEM rollback. Must first remove prior pilot registration.
- The original RMM API/web remain healthy; EPM broker, Edge bridge,
  Windows UAC policy and agent were not changed.

## Next live test
1. Preserve an existing elevated PowerShell window before changing any
   credential provider.
2. Cancel any active UAC prompt. Remove old pilot only with the dedicated
   Uninstall-UacTilePilot.ps1 script if registered.
3. Download new wrapper, verify SHA256 as above and run as admin.
4. Trigger UAC from the standard user by running Notepad with -Verb RunAs.
5. Verify that Hi5Central is the **selected** default tile when it appears,
   not merely visible under More choices. Confirm normal Administrator
   credentials remain available through More choices.
6. Cancel UAC. The pilot cannot submit an approval or authenticate.
7. Confirm automatic rollback after 25 minutes or run the uninstall script.

## Approval engineering blocker
The tested right-click and Edge browser workflows already have a
trustworthy original EXE path, SHA256, signer and user SID/session and can
complete a one-use RMM-approved elevated launch. A custom native UAC
credential tile currently lacks a securely authenticated linkage to the
original process that triggered native UAC. Never turn a business
justification typed in a standalone native credential tile into a generic
admin elevation, inject credentials, or falsely promise that Windows UAC
will automatically resume.

Research a supported pre-UAC request interception/launch broker with an
immutable handle and per-request correlation as a separate, low-risk
extension of the verified EPM broker. Where unsupported, preserve native
Windows UAC and the already-tested Hi5Central right-click/Edge paths.

## Conversation handoff
User confirmed the genuine Windows UAC tile appeared with local reason
field, asked to make it default while retaining More choices for the
normal administrator credentials. Preferred tile code was committed,
regression CI green and package published. No live default-selection test
yet. Original IONOS VPS ubuntu only; do not modify EU.
