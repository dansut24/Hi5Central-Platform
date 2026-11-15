# Hi5Central EPM — automatic application identity for UAC-style approval
Date: 15 November 2026
Project: Hi5Central Newtest Lenovo, original primary VPS only (EU explicitly excluded).

## Decision: never ask the employee to type a Windows file path

The existing pilot UAC credential provider displayed a business-reason field
AND a manually typed EXE path, then offered to post that to RMM. The user
rejected that UX and explicitly withheld further Lenovo testing until the
original file can be identified automatically.

The *documented* Windows credential provider interface exposes usage
scenario, flags, fields, credential enumeration and serialization; it does
NOT expose an authenticated, canonical file name/handle or correlation
identifier for the executable causing the current UAC prompt. Windows'
own secure UAC UI may display an application name, but its text is not
a supported security boundary or authoritative request identity. It
would be insecure to infer the file from the UAC header, last download,
window title, clipboard, recent process or executable basename.

References:
- https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/nf-credentialprovider-icredentialprovider-setusagescenario
- https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/nf-credentialprovider-icredentialprovidercredential-getserialization
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works
- https://learn.microsoft.com/en-us/intune/epm/deployment-planning

Windows' 2026 Administrator Protection Microsoft-Windows-LUA ETW
events 15031 (approval) and 15032 (denied) can include the application
path **after** an elevation outcome under that feature; these are not a
documented input to arbitrary standard-user UAC prompts and do not
provide a verified, pre-approval target bound to the credential provider.
No product behavior should be based on that as a launch authorization.

## Safe design for zero-path end-user experience

1. Capture the original EXE at the **launch entry point**, BEFORE handing
   off to the Windows AppInfo / UAC request, using a supported Explorer
   file command, browser-download callback or Hi5Central managed launcher.
   The existing Hi5Central Explorer "Run with Hi5Central admin" and
   Edge/Chrome bridge ALREADY capture this path without user typing.
2. The user-session companion sends original target plus requesting
   Windows SID/session to the authenticated SYSTEM EPM broker.
3. The broker canonicalizes and verifies the original on-disk EXE,
   Authenticode trust, file handle/hash and publisher; it records an
   exact one-use target, expiry, policy scope and process-launch intent.
   The pending target must be tied to this invocation via an opaque
   nonce and authenticated origin; NOT just "latest file in session."
4. Present the employee with a clear "Hi5Central administrator access"
   dialog already showing application name, publisher and file identity.
   Only the **business reason** is editable.
5. Send the signed/file-bound one-use request to Newtest RMM. On
   approval, notify the standard user and launch the exact original
   file through the already-qualified EPM process broker. Recheck
   identity immediately before launch; reject file replacements,
   replay, changed user/session, revoked signers and expired approvals.
6. For Windows Settings/system actions that lack a stable executable
   launch item, implement explicitly scoped policy-controlled operations
   in Endpoint Management (network settings, UAC-related settings etc.)
   rather than authorizing a generic SYSTEM process or whole-session
   arbitrary Windows administrator token.

## Limit of coverage

**Normal Windows UAC invoked by an arbitrary, uninstrumented app remains
Windows UAC.** A CPUS_CREDUI tile is not a supported, general UAC launch
interception API. The same-prompt resume after remote approval is not
supported through documented Credential Provider interfaces alone.
A future investigation of native process-level interception has to prove
a supported target identity/nonce, preserve secure desktop and user
credential fallback, and be qualified on isolated test infrastructure
before changing a Windows system verb. Never hook/patch consent.exe,
replace built-in UAC providers, disable secure desktop, read or inject
admin credentials, or choose an EXE based on a guessed application name.

## Work carried out 15 Nov 2026

- Removed the manual EXE path field from the native UAC tile **source**.
- Disabled UAC-origin submission unless a trusted original launch target
  is established; it now fails closed with transparent instructions.
- Updated native COM CI tests to assert no path field, no approval or
  credential serialization for an unbound UAC request.
- Windows CI run 43736486032: **PASS**, commit 7556f2aaaebdf55fd1dc7567d7a98f4266652332.
- This interim safety change is **source-only**. It has NOT been installed
  on Lenovo or published as a new end-user release. No additional
  employee test requested.
- The previously installed UAC-RMM pilot was temporary and registered
  an automatic SYSTEM rollback; do not assume its current registration
  without a fresh device check.
- The main EPM service, Explorer verb and browser bridge remain working,
  including one fully verified Notepad++ 8.9.9.1 approved installation.

## Next engineering gate

Determine whether the **original Windows Explorer "Run as administrator"**
launch can be safely redirected BEFORE native UAC using a reversible,
documented file-shell integration that provides exact IShellItem or
canonical path, without replacing or disabling system-wide runas.
Native Shell extensions support additional Explorer verbs and selected
IShellItemArray contexts, but documentation does not establish a way
to generically capture all built-in UAC requests. Never deploy a
system runas override as a workaround without separate approval and
recovery/security qualification. Existing Hi5Central context menu and
Edge bridge already satisfy no-path capture for those supported inputs.

No further Lenovo end-user tests until the automatic file identification
and RMM approval workflow for the intended entry point are in place.

## Continuation

User refuses any manual executable path entry and further testing until
automatic original-target detection. Confirmed CPUS_CREDUI alone cannot
supply trusted UAC original path; a supported pre-UAC launch interceptor
must collect the EXE. Native tile source now no path field and fail-closed;
CI run green; NOT deployed. Preserve default Windows Administrator tile,
working existing EPM/Edge, Newtest scope and original VPS. Do not modify EU.
