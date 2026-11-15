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
