# Hi5Central EPM — Native Windows UAC to Newtest RMM Approval Pilot

Date: 2026-11-15. Infrastructure: **primary original VPS** `ubuntu`, `/opt/hi5central/runtime`, domain `*.hi5central.com`. Do not use/modify EU.

## User-confirmed prior milestones
- Newtest Lenovo standard-user signed Notepad++ 8.9.9.1 installer completed end-to-end via Hi5Central EPM with one-time RMM approval and initial EXE exit 0; user verified temporary H5EP account removed.
- Edge/Chrome download-notification browser bridge confirmed working.
- Native CPUS_CREDUI tile with justification rendered inside a genuine Windows UAC credential prompt. Windows native Administrator remained default; Hi5Central appeared under More choices.
- Installed preferred-tile build was **independently confirmed on Lenovo** via authenticated RMM Agent read-only job b6fef4ba-1c66-4588-bcec-35efec854435. DLL SHA `147938D701D56C0AF6365D8AE2317A17A61B0AC0443A111D13F2EE688EA517D7`. Thus installer was correct; Windows credential selection does not guarantee cross-provider default. No filtering of built-in credentials.

## Implementation
The next experimental tile has **two editable inputs**, business justification (20–512 characters) and an **explicit full local path to a signed EXE**. It offers `Request approval in Hi5Central RMM`. A credential provider does **not** receive a trustworthy original UAC target path, so the EXE path is required and may be different from the app that triggered the UAC prompt. No arbitrary generic elevation is permitted.

When clicked:
1. The native credential provider sends `uac-request` over a local named pipe to the existing EPM broker. No Agent secret, admin password or token enters the UAC DLL.
2. The SYSTEM broker verifies the caller is an actual Windows Credential UI process in the same interactive session (`consent.exe` / `CredentialUIBroker.exe` under Windows System32), resolves the interactive user with `WTSQueryUserToken`, and uses the existing `VerifiedFile.Inspect` Authenticode, SHA-256, publisher and local-file path checks.
3. The existing Agent-authenticated EPM request endpoint creates a normal, **per-file and per-user bound** pending approval in Newtest RMM. `request_source='native-uac'` is audit metadata only.
4. A technician approves the exact signed file in `https://newtest-rmm.hi5central.com/elevation-requests`. The existing Windows watcher detects approval for that user/session.
5. **The user must CANCEL the original Windows UAC prompt** after submission. The existing notification can launch the manually selected, verified file elevated, with hash/signer revalidation and one-time approval consumption. This does **not** resume the original pending Windows UAC prompt. There is no credential injection or UAC policy change.

The existing Explorer/Edge EPM flows continue to use `request_source=explorer`. All other tenants/devices are excluded through the existing RMM_EPM_PILOT_TENANT/DEVICE guards.

## Verified builds and deployment
- Windows EPM broker CI run `43733599826`: success. EPM native-host security self-test and existing job protocol pass.
- Windows UAC tile CI run `43733117756`: success. Native COM field validation and no-credential serialization pass. A **live native UAC-to-broker pipe request is not yet tested**.
- Primary VPS RMM API and web are healthy, deployed images:
  `hi5central/rmm-api:epm-native-uac-source-20261115`,
  `hi5central/rmm-web:epm-native-uac-source-20261115`.
- Migration `187_epm_uac_request_source.sql` applied; adds audit-only `request_source` column.
- Prior EPM binary SHA `7A61965321851DB6D9346422AADDFBF9C1E10846F446EAF4CD99C000D15CAAAF` matched Lenovo before upgrade.
- First EPM remote updater failed to replace a still-open EXE and safely restored the prior broker. A V2 updater waits for all EXE process handles to release and retries transient file locks.
- **Lenovo EPM broker successfully upgraded via RMM job `be145436-0508-4f43-bc53-a829ac88928e`**, service Running, exact EXE SHA `B18D5D70A5035853E9CD1D21178B34A03FBAB60767896DDA451CF7352C152AA8`, exit 0.
- **Lenovo native UAC tile successfully upgraded via RMM job `b3f10801-9d6f-4abb-88be-cd2ef9665fd0`**, exact DLL SHA `E751402357A0A47420E8700132212A5DC2DD7BEBFEBF82555A909C1934990329`, registered, automatic rollback scheduled at **2026-11-15 16:50:40 GMT**, exit 0.
- Final RMM Agent read-only job `e771425d-438c-47a8-9524-56b49ecdbb5b` confirmed both hashes and Running EPM service. **No user-session `--watch` process was running** after broker upgrade. User must start it in a normal, non-administrator PowerShell window for the first test (no sign-out).

### Reinstall artifacts (after automatic rollback if needed)
1. Broker V2:
`https://downloads.hi5central.com/epm/uac-rmm-broker-20261115/Upgrade-Hi5Central-EPM-UacBroker-V2-20261115.ps1`
SHA256 `BCBFC6825BE5B4A3B34281014D902F813C98C67CECFC7D55C6F5961F633E59FD` (idempotent once new binary installed).
2. UAC tile:
`https://downloads.hi5central.com/epm/uac-rmm-tile-20261115/Install-Hi5Central-UacRmmTile-20261115.ps1`
SHA256 `F1C715CF0E49B529CB937F33FA86162AEA20E9DC6E99EAEE60886FF0AF38D2BD`.
3. Existing standalone rollback:
`& "$env:ProgramFiles\Hi5Central\EPM\UacTilePilot\Uninstall-UacTilePilot.ps1"`
(run from elevated PowerShell). The scheduled SYSTEM rollback runs after 25 minutes and removes only pilot COM/credential-provider registration, leaving the DLL inert on disk.

## First live acceptance test (not yet performed)
1. In a standard-user PowerShell window run
`Start-Process "$env:ProgramFiles\Hi5Central\EPM\Hi5CentralEpmPilot.exe" -ArgumentList "--watch"` so the approval notification watcher is active without sign-out.
2. Download/locate a suitable signed EXE in Downloads, such as the prior Notepad++ installer. Obtain its **full path**. Windows system utilities like Notepad.exe and PowerShell.exe are not eligible for this signed-file pilot.
3. As standard user trigger a native UAC credential prompt (e.g., Notepad -Verb RunAs); select Hi5Central under More choices.
4. Enter the business justification (20+ characters) AND the **explicit full path to the signed EXE**. Select `Request approval in Hi5Central RMM`. The tile should report submitted. **Cancel native UAC**, never press Yes or enter Windows credentials into Hi5Central.
5. Inspect Newtest RMM queue. Verify `request_source='native-uac'`, correct user SID/session, exact path, signer, hash and reason.
6. Approve once with a reason, wait for Windows watcher notification. Use the notification to launch only the manually selected EXE (NOT automatically the original UAC target). Check process lifecycle and H5EP/admin desktop ACL cleanup; confirm previously qualified Explorer/Edge flows still work.
7. If the request is rejected by service, preserve fail-closed; investigate actual credential host PID/session and ACL without disabling UAC or accepting unverified executable targets.

## Security / outstanding limitations
- The UAC Credential Provider cannot presently extract a verified path of the ORIGINAL program that triggered UAC or resume that exact suspended Windows action.
- Signed EXE path is user-selected inside the tile; a review approves that explicit file only, with verified per-file identity and one-time use.
- The COM tile returns `CPGSR_NO_CREDENTIAL_NOT_FINISHED` and never supplies admin credentials. Windows Administrator password remains available under More choices.
- No broad local admin membership, generic SYSTEM command execution, credential injection, modified UAC policy, or changes to EU.
- Windows CI passing **does not prove the new UAC-to-RMM interaction succeeds on Lenovo**. Do not claim production qualification until the full live test.

## Continuation summary
User asked to confirm correct UAC version and integrate reason/approval with RMM. Verified preferred DLL on Lenovo, determined Windows still chooses Administrator by provider precedence. Implemented real UAC tile reason+explicit file path -> authenticated EPM broker -> existing RMM file-specific pending approval, with source label. RMM API and UI deployed, EPM service and UAC DLL remotely upgraded on Newtest Lenovo and hashes verified. Original working launch path unaffected in code. Need user-session watcher startup (no sign-out) and **one full live UAC-to-RMM test**. UAC automatic rollback scheduled at 16:50:40 GMT on Nov 15, 2026. Keep main native Windows UAC secure desktop intact; EU untouched.
