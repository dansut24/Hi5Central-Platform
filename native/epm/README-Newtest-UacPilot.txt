Hi5Central Newtest native UAC + RMM single-build pilot (15 November 2026)

WHAT IS INCLUDED
- Hi5CentralEpmPilot.exe (.NET 8 Windows broker + tray notification watcher)
- Hi5CentralUacTilePilot.dll (native Windows CPUS_CREDUI provider)
- Install-Newtest-UacPilot.ps1 (single installer, hash validation, Newtest device gate)
- Uninstall-Newtest-UacPilot.ps1 (manual and automatic recovery)
- Run-Newtest-UacCases.ps1 (five real Windows UAC prompts + verified EXE test instructions)
- Component installer/rollback scripts and SHA256.txt

SECURITY AND CAPABILITY
This build displays a Hi5Central EPM choice under Windows UAC More choices.
The user enters a business justification; the Windows broker authenticates the
consent host and forwards a review-only request to RMM. RMM can record a
security review or reject the request with a reason. The user watcher displays
the outcome without granting administrator rights to an unidentified operation.

For a separately verified signed EXE, right-click in Explorer and choose
Run with Hi5Central admin. RMM can approve a single exact signed file for
one session and a 15-minute window; the Windows watcher notifies the user
and permits one launch. There is NO manually entered file path in native UAC.

IMPORTANT: Windows's supported credential-provider API does not expose the
original target application or administrative operation. This pilot cannot
resume arbitrary UAC prompts after RMM reviews. Do not describe a native UAC
security review as authorization. Do not bypass native Windows UAC.

INSTALL ON THE NEWTEST LENOVO ONLY
1) Extract the single ZIP to a local folder.
2) Open 64-bit PowerShell as administrator.
3) Run: .\Install-Newtest-UacPilot.ps1 -RollbackMinutes 45
4) Check that the installer reports service Running, tile registered and
   automatic SYSTEM rollback scheduled.
5) Sign in as the standard user. Run .\Run-Newtest-UacCases.ps1 in a
   non-elevated PowerShell window.
6) In each Windows UAC prompt: More choices > Hi5Central EPM.
   Enter a reason longer than 20 characters, submit for RMM review.
   Cancel the Windows prompt after the review is sent.
7) In RMM: https://newtest-rmm.hi5central.com/elevation-requests
   Record review or reject with an explicit reason, then verify notification.
8) Separately test the Explorer signed EXE path (per-file approval -> click
   Windows notification -> one-time verified launch).
9) To stop pilot early, run as administrator:
   .\Uninstall-Newtest-UacPilot.ps1

TEST CASES
1. Notepad - Run as administrator
2. Registry Editor - Run as administrator
3. MMC Services console - Run as administrator
4. Windows PowerShell - Run as administrator
5. Windows Installer (msiexec /?) - Run as administrator; no package installed
6. Explorer - Run with Hi5Central admin on a known trusted signed EXE

CI tests only build, COM/CredUI behavior and isolated component installation.
A REAL end-to-end test must run interactively on the Newtest Lenovo device.
The native approval/elevation path remains unqualified for arbitrary UAC.

RECOVERY
The Windows Credential Provider registration and prior EPM broker are
automatically rolled back after the configured test period.
No Windows built-in providers, Windows UAC policy, self-service Company Portal
or main RMM Agent are changed by this package.

NEWTEST VERIFIED EXE AUTO-START (V3)
If the user chooses Explorer > Run with Hi5Central admin and checks the
opt-in to start automatically, the exact verified EXE can start once after
technician approval. The user must remain in their Windows session and the
Hi5Central EPM notification watcher must be running. The original signed
file identity is rechecked and approval is consumed once. An already pending
legacy approval cannot be converted into automatic execution retrospectively.
Native UAC reviews without a verified target remain review-only and do not
launch or authenticate Windows prompts. Log off/on after upgrading the broker
to replace an earlier notification watcher; then create a fresh EXE request.


FIVE REGISTERED WINDOWS UAC ACTIONS (MANAGED PILOT V4)
This pilot adds five Start Menu entries in 'Hi5Central EPM Newtest' and
an interactive test menu. Each entry has a fixed, compiled operation code.
It registers the exact Windows-signed executable and immutable arguments
with the authenticated local SYSTEM broker BEFORE opening a real UAC prompt:
  notepad        = System32/notepad.exe (no arguments)
  regedit        = Windows/regedit.exe (no arguments)
  services       = System32/mmc.exe services.msc
  powershell     = System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NoExit
  msiexec-help   = System32/msiexec.exe /?
The employee selects More choices > Hi5Central EPM in the resulting native
UAC screen and enters a justification. The broker checks the trusted UAC host,
consumes the short-lived, SID/session-bound intent, then records a separate
managed-uac signed-file request in RMM. RMM must approve the exact file and
fixed argument digest. The employee CANCELS the original Windows UAC prompt.
After approval, the Windows watcher requests a separate single-use launch with
the pre-registered program/arguments. The broker rechecks Authenticode, hash,
SID/session, operation code, argument digest and one-time redemption.

An unprepared UAC prompt is still REVIEW-ONLY: the credential tile cannot
identify its target from Windows and never grants generic admin credentials.
The managed action is NOT a continuation of a cancelled Windows UAC request.
Do not approve PowerShell or Registry Editor casually: they are broad-purpose
administrative applications despite their fixed initial invocation.
The environment remains scoped to the Newtest Lenovo device and time-limited
automatic rollback remains in force. The five real Lenovo tests must be run
interactively; Windows CI cannot exercise a live secure desktop approval.

V6 EXPANDED ENTRY POINT: ORDINARY WINDOWS SHORTCUTS
A user may right-click a local Start Menu or desktop .lnk shortcut
(Show more options > Run with Hi5Central admin). The native user companion
resolves the exact executable with Windows Shell Link COM. Shortcuts with
arguments or remote, missing, script, URL and nonsigned targets are refused.
The existing SYSTEM EPM broker then independently verifies the actual signed
EXE, file hash, requesting SID/session and one-time RMM approval. No native
UAC bypass or generic administrator credential is issued. Windows 11 may
show the integration under its legacy context-menu view. This feature
requires interactive Newtest validation before production qualification.

V6 SERVER-SIDE SECURITY PROFILE
- Newtest remains an explicitly scoped PILOT for legacy single-approver
  qualification; one-time approvals now expire after 3 minutes for critical
  tools, 5 for high risk and 15 for controlled Windows Installer help.
- Future production enablement defaults to HARDENED. PowerShell and Registry
  Editor are blocked unless the break-glass policy is explicitly enabled.
  When enabled, two DIFFERENT technicians with both RMM policy-management
  and security-settings permissions must approve separately. The first
  approval is never executable. A second approval has a 3-minute window.
- A high-risk tool running with full administrator rights can still change
  Windows state and launch descendants; the five original Windows action
  options are NOT a command sandbox. Future routine IT operations should
  use typed, narrow workers (e.g. service state or allowlisted registry keys).
- No policy permits unknown native UAC requests to release credentials.
