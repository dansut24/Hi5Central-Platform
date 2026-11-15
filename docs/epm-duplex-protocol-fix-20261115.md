# Hi5Central EPM — duplex named-pipe protocol reproduction and repair
**Date:** 15 November 2026 | **Scope:** Newtest Lenovo EPM pilot (not qualified for production)
**Infrastructure:** original IONOS VPS `ubuntu`, `/opt/hi5central/runtime`, `*.hi5central.com` ONLY. Do not touch EU.

## Observed incident
- User's 12:16 test screenshot: `Approved launch failed at desktop-grant-protocol (Windows error 0)`.
- Latest RMM EPM request: `2c1c42cf-7cce-47d8-897d-03becb55319f`.
- Approval was redeemed but **no Windows process ID or installer completion was recorded**.
- Earlier separate failure: `desktop-query-identity` Win32 5; OpenDesktop rights were corrected but a distinct pipe exchange defect remained.

## Reproduced cause, not just a screenshot inference
A new Windows CI-only test `PipeProtocolSelfTest` exercises the *same*
`EpmService.RequestDesktopGrant` method on a Windows named-pipe server and
client. It uses a fake admin SID and returns fabricated ACKs. It never creates
Windows accounts, edits real desktop ACLs, makes RMM approvals or executes apps.

The test originally failed with a 12-second/27-second timeout:
- Server connected and read request.
- Server began `WriteAsync(challenge).GetAwaiter().GetResult()`.
- Client **received** the 58-byte challenge.
- Server never got the async completion, so it never read the ACK.
Removing `FlushAsync` did not resolve this. Replacing the tiny intermediate
challenge write with synchronous `pipe.Write` let both parties proceed,
but `ReadAsync(...).GetAwaiter().GetResult()` failed with an
`InvalidOperationException` masked as `desktop-grant-protocol`.
- Replacing that sync-over-async read with a bounded synchronous `pipe.Read`
made **both the success and explicit Windows-error-5 rejection tests pass**.
- Added 18-second watchdog that closes the pipe and fails closed when the
  user-side companion never sends the acknowledgment.
- Added a third test that withholds ACK and asserts that exact watchdog timeout.
- Removed unnecessary `FlushAsync` on the duplex pipe in client and server.

**CI:** Windows run `43714442467`, commit
`a797f79a7f7c52ebd8c43da79656f0843a2bf164`, conclusion **success**.
Compiled, passed simulated grant/deny/timeout protocol tests, verified the
broker service can install and uninstall on the isolated Windows runner.

## Published *Newtest-only* updater, not installed yet on Lenovo
URL: `https://downloads.hi5central.com/epm/duplex-pipe-20261115/Upgrade-Epm-DuplexPipe-20261115.ps1`
Script SHA-256:
`5516A0431FC06DBBFF4B0D06A4D627D23464A812B57A663D3FA3B5447EF62613`
CI package SHA-256:
`837B322D31194CE793F58C3D3B0D6A9C24C2E77E189B4FF36A8AD3A451E36E27`
New Windows EXE SHA-256:
`05E822197E2924F7FDD1231BB0104B0230EFF6767514D5AC9926CDA23464A9EF`
Updater requires existing known EPM EXE SHA:
`A29DFE808A36DDB97AFE790D076912FFEAEB2CE1B9DCAD5121495A86AE8FFACE`.
It refuses unknown existing versions and any existing `H5EP*` account; verifies
package and executable, preserves a rollback binary during replacement.
No changes to UAC, main Agent, app portal, policy, EU environment.

## Next acceptance test (Lenovo)
1. End/close old EPM error dialog. Run the checksum-verified upgrade from
   Administrator PowerShell; `Get-Service Hi5CentralEpmPilot` must be Running.
2. No sign-out necessary; watcher starts automatically on first right-click.
3. As **standard user**, in normal PowerShell run:
   `& "$env:ProgramFiles\Hi5Central\EPM\Hi5CentralEpmPilot.exe" --desktop-preflight`
   (no elevation/approval consumed). If it fails, stop and inspect its exact error.
4. Only after preflight succeeds, request one **fresh** Notepad++ approval,
   approve in Newtest RMM, use notification/retry.
5. Check visible, interactive Notepad++ installer, app inventory transitions
   8.9.8.1 -> 8.9.9.1, process exit/status, and removal of temporary
   `H5EP*` user and desktop ACE. Do not call it qualified until all pass.
6. If new failure, query latest `rmm_epm_file_requests` (stage/code and
   process lifecycle); do not consume more approvals blindly.

## Architectural direction (Admin By Request style)
- Keep working approval/notification/audit flow and one-time file identity.
- Prioritize a reliably restricted, user-session interactive elevation engine
  instead of ever-wider permissions or generic SYSTEM execution.
- For downloaded files, use a supported Edge/Chrome extension + Native Messaging
  to offer EPM after a download completes; supported Explorer right-click
  remains fallback.
- Windows secure-desktop UAC must remain intact; no consent.exe hooking, UI
  credential injection, UAC disablement, fake Windows UAC prompting or
  persistent user administrator membership.
- A separate RMM-managed silent installation workflow via existing trusted
  PatchHost/self-service broker is a sensible compatibility fallback for
  installers that cannot run interactively under an isolated identity.
- Compare acceptance criteria with Microsoft Intune EPM Support Approved and
  Admin By Request, while keeping Hi5Central self-hosted.

## Continuation
Current source branch `feature/epm-file-elevation-pilot-20261114`.
Primary VPS RMM API/web healthy on 15 Nov 2026. **New updater is published but
has not yet been executed on the Lenovo**. Next step is standard-user
preflight, then one approved Notepad++ installer attempt if preflight passes.
