# Hi5Central EPM — Windows UAC and browser-download integration
Date: 2026-11-15
Pilot: Newtest Lenovo only; primary VPS `ubuntu`, `/opt/hi5central/runtime`; no EU use.

## Target employee experience
A standard user downloads a trusted, signed installer through Edge or Chrome,
receives a Hi5Central prompt asking whether to request elevation, supplies a
business reason, gets approval in RMM, and clicks **Run approved installer** in
the original Downloads location. No App Portal assignment or copying EXEs is needed.
A standard Windows UAC prompt is retained for actions not controlled by Hi5Central.

## Supported boundaries
Windows UAC credentials/consent operate on the secure desktop. Do **not**
hook `consent.exe`, inject administrator credentials, replace Windows system
files, globally disable UAC, or change secure desktop configuration.
Admin By Request's own Windows docs explicitly say it does not replace or tap
UAC, despite its UAC-like application elevation UI.

References:
- Microsoft UAC security: https://learn.microsoft.com/en-gb/windows/security/application-security/application-control/user-account-control/how-it-works
- Admin By Request Windows UAC: https://docs.adminbyrequest.com/endpoints/Windows/portal.htm
- Admin By Request browser extension architecture: https://docs.adminbyrequest.com/support/tech-notes/windows-browser-extension.htm
- Microsoft desktop rights: https://learn.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-opendesktopa

## Proposed Windows integration implementation
1. Keep `Run with Hi5Central admin` Explorer verb as the explicit, testable
   application elevation path. Do not overwrite `runas` or default EXE association.
2. Enterprise-manage an Edge/Chrome extension for download-complete events.
   It only reads the downloaded file's metadata/path after the browser reports
   completion. It uses Chrome/Edge Native Messaging to call a **signed, local**
   Hi5Central user-session companion; the extension never holds credentials,
   never passes an executable command line, and cannot directly run privileged code.
3. Companion shows a Windows notification **Request admin access to install**.
   When clicked, it invokes the existing authenticated request/approval flow.
   Broker verifies device, user SID, session, publisher, file SHA-256 and
   signature; approved launch re-opens and pins exactly the same original EXE.
4. Keep a separate **approved file retry** action in Company Portal and Explorer.
   Notifications are started without sign-out, are single-instance, and stop
   when the user signs out; service updates should not disable notifications.
5. Build a **UAC-triggered action coverage matrix** for double-click from
   File Explorer, browser Open, setup bootstrapper child MSIs/EXEs, task
   elevation, system Settings, and script interpreters. Only enable documented,
   verified integrations. Uncovered cases continue to use native UAC.
6. Investigate use of supported Windows credential-provider/UI mechanisms
   **only in a disposable Windows QA virtual machine**. They do not grant a
   generic right to replace consent.exe or bypass secure desktop; any approach
   must preserve UAC security and Windows update compatibility.
7. RMM policy: require reason and approval by default; allowlist signer/hash
   and published version; deny browsers, command shells and scripting tools
   in initial releases; record one-use token, expiry, caller, file identity,
   process start/end, Win32 code and observed install result separately.

## Current blocker and precise fix
The user-session helper used `OpenDesktopW("Default", ..., READ_CONTROL|WRITE_DAC)`
and then called `GetUserObjectInformationW` to check UOI_NAME/UOI_TYPE.
Microsoft requires `DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS` when
`READ_CONTROL` or `WRITE_DAC` are requested in `OpenDesktop`.
Missing rights plausibly caused `desktop-query-identity` Win32 5 on Lenovo.
Fix: open with `READ_CONTROL|WRITE_DAC|DESKTOP_READOBJECTS|
DESKTOP_WRITEOBJECTS`, and window station with `READ_CONTROL|WRITE_DAC|
WINSTA_READATTRIBUTES`. Run `--desktop-preflight` as standard user
**before** requesting another approval; preflight must check UOI_NAME
without altering ACLs.

## Qualification gates
A. Standard-user preflight opens and reads both local interactive objects;
   no elevation and no persistent DACL changes.
B. Newtest RMM approval for Notepad++ 8.9.9.1 succeeds, valid file
   launches visibly in the current user session, installer is interactive.
C. Installer finishes and inventory confirms version change; process exit
   is not incorrectly treated as installation success.
D. Temporary H5EP identity and exact ACL ACEs removed. Test service restart,
   client crash, job timeout, rejected/expired/replayed approval, file swap.
E. Edge extension test: download completion -> Hi5Central prompt -> approval
   -> exact original file launch; no broader privileges, no silent elevation.
F. UAC coverage documentation: unsupported triggers use unchanged Windows UAC.

## Chat continuation handoff
2026-11-15: User wants an Admin By Request-like seamless experience and
investigation of UAC/browser integration alongside fixing failed Notepad++
pilot. Last screenshot `desktop-query-identity`, Win32 5; server recorded
`desktop-grant-protocol` for request
`f416054c-7c57-4a48-86fb-d8c11d754c38`. Windows OpenDesktop ACL access
flags missing mandatory object read/write rights. Source fix committed
on `feature/epm-file-elevation-pilot-20261114`; next is Windows CI,
checksum-pinned Newtest update, standard-user non-elevating desktop preflight,
then one approval/launch test. Do not touch EU.
