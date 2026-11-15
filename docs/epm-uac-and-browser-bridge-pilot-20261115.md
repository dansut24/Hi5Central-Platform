# Hi5Central EPM — browser-to-approval pilot and native UAC research
**15 November 2026** | **Newtest Lenovo only**

## State and scope
The native EPM pilot has **one completed and successful live test**:
standard user requested Notepad++ 8.9.9.1 from original Downloads,
technician approved, PID 16680 started and completed with exit code 0
(`job-empty`), software inventory confirmed 8.9.9.1 and the user reported
no H5EP temporary local user after completion. That working service and
Agent are not changed by this browser bridge.

The browser bridge is a new, independent **standard-user** component. It is
not installed or interactively tested on the Lenovo yet.

## Employee UX implemented
1. After a completed `.exe` download in Edge/Chrome, the Hi5Central MV3
   extension posts a notification **Request admin access**.
2. User clicks the notification (or the Hi5Central extension icon to
   select the most recent completed EXE).
3. The extension uses browser-native `runtime.sendNativeMessage` to the
   specifically registered `com.hi5central.epm_browser` Windows host.
4. The host checks a fully qualified local executable inside the signed-in
   user's Downloads folder; rejects UNC, non-EXE, path traversal, missing,
   reparse and non-fixed-drive files; never executes arbitrary strings or
   runs elevated itself.
5. Host launches the existing `Hi5CentralEpmPilot.exe` requester *as the same
   standard user* with the original executable path as an argument, without
   copying the installer.
6. Existing EPM asks **why** (minimum 20 characters); Windows service
   authenticates SID/session and validates signed EXE SHA-256 and publisher;
   RMM technician approves or rejects, scoped to Newtest.
7. Existing `--watch` Windows notification shows the decision. Clicking
   an approved notification calls the existing, one-time, short-expiry
   `RequestOrLaunch` flow and starts the same signed original EXE elevated
   through the qualified EPM broker. Process lifecycle is audited.

## Not supported/claimed
- The extension does **not** intercept the browser's built-in Open button.
- It does **not** pause and resume a native secure-desktop UAC prompt.
  For browser downloads, user must click the Hi5Central notification/icon
  **instead of opening the EXE through the standard UAC prompt**.
- Double-clicking an arbitrary EXE in Explorer still uses Windows UAC.
- Other file types and Downloads folders redirected to network shares are
  not supported in the initial pilot.
- An extension does not replace secure-desktop UAC, `consent.exe`, login
  credential providers, system EXE associations or security policies.
- No automatic approval, silent elevation or default browser downloads
  execution; reason + technician approval remain mandatory.

## Signed/identity-bounded integration
- Stable unpacked QA extension ID:
  `mdablcgpimddfidkjilfglpcaolpopda`.
- Extension `manifest.key` contains only the **public RSA key**, not
  the private key. The private QA key is protected on the original VPS;
  do not disclose or distribute it.
- Native host name `com.hi5central.epm_browser`.
- Exact native host allowed origin:
  `chrome-extension://mdablcgpimddfidkjilfglpcaolpopda/`.
- Installer registers only
  `HKLM\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\...` and
  `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\...`.
- Host resides under `%ProgramFiles%\Hi5Central\EPM\BrowserBridge`.
  The extension itself is loaded unpacked in QA; production publication,
  signing, policy deployment, uninstall and upgrade are future work.
- New host cannot confer admin rights; existing EPM service handles
  policy, one-time authorisation and privileged process creation.

## Windows CI and published version
- Source branch `feature/epm-file-elevation-pilot-20261114`.
- Workflow `.github/workflows/epm-browser-bridge-windows.yml`
  run `43719260256` passed, commit `0f60ee65aec444911049eed402a9837bc3ed3772`.
- CI tests: native framing, malformed/oversize messages, unsafe local
  paths, extension JS syntax, manifest sanity and PowerShell installer
  parse, plus Win64 self-contained .NET 8 publish.
- CI bundle:
  `https://downloads.hi5central.com/epm/browser-bridge-20261115/Hi5Central-EPM-Browser-Bridge-CI.zip`
  SHA256 `073BF196FD39BE5EE90938320D3A070C4520071A5D458824E5C3719F7ED4EB7A`.
- Host EXE SHA256:
  `D26552EA1CA97E6599036A45FB4DCA6E2314BBB4EB28C8C32AC6DA08F7A4291F`.
- Newtest installer:
  `https://downloads.hi5central.com/epm/browser-bridge-20261115/Install-Hi5Central-Browser-EPM-20261115.ps1`
  SHA256 `3DD7B3C2D8B5CA56C9FA5BDD734829127BC037B63930AA469D87F9B59330A4B1`.
- Files staged on original VPS; **no Windows browser-side live test yet**.
- Main RMM API/web healthy; Agent and EPM service untouched.

## Real UAC credential-tile R&D — next major engineering track
Microsoft documents a custom credential provider interface used by Credential
UI; specifically `CREDENTIAL_PROVIDER_USAGE_SCENARIO.CPUS_CREDUI`
applies to *over-the-shoulder UAC prompts*.
This may offer a closer native experience, with a custom **Hi5Central
Request elevation** credential tile on a Windows UAC credentials prompt.

**Feasibility and security are not yet established.** A provider is
responsible for producing valid credential serialization; it is not itself
an enforcement mechanism, and it does not automatically supply the file
identity, original command line or process tree. Confirm whether UAC
provides enough immutable target metadata for request binding. Avoid
using generic reusable admin credentials or silently changing policy.

An unqualified custom credential provider is high risk: incorrect native
COM registration or implementation can break OS credential UI. It must be
developed and tested **only on a disposable Windows 11 VM with snapshot and
out-of-band recovery**, without filtering or wrapping Microsoft built-ins.
It must never disable native Windows password, PIN or Windows Hello providers.

Microsoft references:
- https://learn.microsoft.com/en-us/windows/win32/api/credentialprovider/ne-credentialprovider-credential_provider_usage_scenario
- https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows
- https://learn.microsoft.com/en-gb/windows/security/application-security/application-control/user-account-control/how-it-works
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging

## Next live Newtest browser test
1. Install browser bridge using verified updater in Administrator PowerShell.
   **No restart of EPM service, no Windows sign-out.**
2. Sign in as a standard user, open `edge://extensions`, enable Developer
   mode, choose **Load unpacked** and point to
   `C:\Program Files\Hi5Central\EPM\BrowserBridge\extension`.
3. Confirm extension ID exactly matches the pinned QA ID above.
4. Download a signed EXE into the local Downloads folder via Edge.
   Use the Hi5Central **Request admin access** download notification,
   not Edge's normal open/run button; or click the extension toolbar icon.
5. The same EPM reason dialog must appear without administrator credentials.
   Submit, check pending request in Newtest RMM, approve once, observe Windows
   approval notification and launch only from that approved notification.
6. Verify target original Downloads file hash/signer binding, process exit
   and local temporary admin cleanup. Reject/expiry/file-switch must fail closed.
7. Test browser bridge absence, invalid extension ID, changed Downloads
   path and invalid .exe as safe failures, preserving existing Windows UAC.

## Chat continuation handoff
15 November 2026: User confirmed H5EP temporary account removed after
successful Notepad++ EPM test and asked for an Admin By Request-like
experience tied to ordinary UAC prompts, including reason, technician
approval and notification-resumed elevation. Explained native secure
UAC cannot simply be paused/resumed by a shell plugin. Implemented
standalone Edge/Chrome download notification/native messaging pilot on
feature branch, with CI PASS, downloadable package and installer; not
installed/tested on Lenovo yet. Native UAC credential provider CPUS_CREDUI
is a separate high-risk research direction for an isolated Windows VM.
Use only original VPS `ubuntu`; never modify EU without instruction.
