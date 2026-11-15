# Hi5Central EPM — universal Windows elevation coverage gate

**Decision date:** 15 November 2026
**Owner requirement:** An employee must not manually enter or identify an EXE path, navigate Downloads, or distinguish elevation mechanisms. All elevation scenarios should have a Hi5Central-managed request/approval flow wherever the operation can safely be identified and reproduced. Do not test a Downloads-only pilot and call it complete.

## Technical reality / non-negotiable honesty

A third-party Windows Credential Provider with `CPUS_CREDUI` may display a
Hi5Central tile for over-the-shoulder UAC credential prompts. The documented
interface does **not** expose a trustworthy identity for every underlying
operation, nor a supported token that can suspend and resume an arbitrary
AppInfo/UAC operation after RMM approval. Some UAC prompts are not even
associated with a standalone installer EXE; they arise from MSI services,
COM elevation, Windows Settings, administrative shell operations, protected
file/registry writes and nested child processes. Guessing the target from
a caption, clipboard, recent downloads, current foreground window or process
name is strictly prohibited.

This is not unique to Hi5Central: Microsoft's Intune EPM documents support
for .exe/.msi/.ps1 while explicitly listing Settings/UWP limitations;
Admin By Request documents cases where its elevation handling falls back
to normal UAC. Therefore **100% replacement or native same-prompt resume of
every Windows UAC prompt is not a deliverable claim** without an independently
verified supported mechanism; no release should make that promise.

## Product target: one consistent end-user request experience

The managed system consists of several explicit, auditable routes rather
than a single untrusted custom credential tile:

| Trigger/operation | Identify and bind | Proposed secure execution | Current live status |
| --- | --- | --- | --- |
| EXE directly from Explorer | Selected shell item / canonical on-disk file + signed hash + requester token | Existing EPM one-use interactive process broker | PASS via explicit Run with Hi5Central admin; ordinary double-click universal capture NOT DONE |
| EXE from Edge/Chrome | Browser download item / canonical file + signed hash | Existing EPM broker | PASS via user-clicked notification, not arbitrary browser Open |
| EXE launched from Start menu, taskbar, shortcuts, other apps | Need verified pre-launch target, command-line/arguments and identity | Managed launcher or targeted, supported integrations only | NOT IMPLEMENTED |
| MSI/MST/MSP installation, repair, uninstall | Installer package, product code/version, trusted package hash and operation | Windows Installer approved management worker with limited command semantics | NOT IMPLEMENTED |
| PowerShell scripts, CMD/BAT, command interpreters | Approved signed/pinned script content, interpreter, exact safe command and parameters | Privileged policy-managed script executor; no generic arbitrary shell | NOT IMPLEMENTED |
| Administrative Windows Settings / Control Panel | Specific operation and parameters (not just system UI EXE name) | Existing endpoint policy/capability-specific brokers | PARTIAL endpoint management independently; UAC integration NOT IMPLEMENTED |
| Services, registry, scheduled tasks, driver controls | Specific resource ID and requested verb | Scoped Windows management actions; audited / reversible | PARTIAL endpoint management independently; UAC integration NOT IMPLEMENTED |
| Privileged Explorer file copy, move, delete, ACL | Original source/destination, identities, exact permission changes | Privileged narrowly-scoped file operation broker | NOT IMPLEMENTED |
| Child EXE/MSI launched by an approved installer | Parent job identity, child signer/sha/arguments, policy, max process tree/time | Explicit child policy or separate approval; deny arbitrary child privilege | NOT IMPLEMENTED |
| UWP/AppX/package/COM and OS-specific secured operations | Per-operation supported OS API or managed application workflow | Explicit controlled operation if available; else Windows UAC | NOT IMPLEMENTED |
| Unidentified/cannot be safely reproduced | **Never infer target** | Preserve built-in Windows UAC; report "not managed" without misleading approval | BY DESIGN |

Each scenario should have an acceptance test for: user reason only, visible
app/action name, correct SID/session/tenant, trusted target binding, approval
denial, expiry, one-time redemption, audit, restart/offline failure, and
privilege and temporary-account cleanup. No auto-approved generic privileged
shell. Reject unsigned/user-writable substitutes except separately managed
and cryptographically pinned packages with explicit policy.

## Supported system architecture and work packages

1. **Request identity protocol**: a typed, immutable launch/operation envelope
   (`EXE`, `MSI`, `SCRIPT`, `WINDOWS_ACTION`, `FILE_OPERATION` etc.)
   containing a unique one-use nonce, requesting user SID, Windows session,
   tenant and device; exact canonical file/operation/args + signer/digest,
   short TTL, parent-child lineage and audit label. Bind to an authenticated
   *pre-execution* request; do not identify an arbitrary operation retroactively
   by matching window text or "most recent in session."
2. **Capture adapters**: Explorer file-item context, Edge/Chrome already
   operational; add individually supported Start/shortcut, MSI and scripted
   launch adapters with explicit allow/deny coverage. Ordinary native UAC
   prompts cannot be globally hijacked via CPUS_CREDUI.
3. **Policy/elevation workers**: existing EPM per-file process broker;
   dedicated MSI, script and narrow Windows administration workers. Choose
   job-limited execution and fail closed rather than unrestricted SYSTEM
   or permanent local Administrators membership.
4. **User interface**: one Hi5Central request/reason UI fed by the already
   captured target; employee never enters file paths. Native UAC tile only
   presents a submission action if a trusted, particular prelaunch intent can
   be associated with that *exact* prompt through a verified, supported
   mechanism; otherwise show clear guidance and ordinary Windows credentials.
5. **RMM / audit**: source/type, signed item or operation, user/session,
   changes and rollback, approval actor/time, policy, revoke/replay controls,
   child processes and outcome. Existing Newtest approval queue is the
   current backend for EXE and must be extended per type.

## Release blockers and acceptance matrix

DO NOT deploy a new "universal UAC interception" client to Newtest or
ask the employee for another Lenovo trial based on a narrow EXE adapter.

**Required before the next end-user integration test**:
- Define a coverage matrix of standard-user Windows actions across Explorer,
  browser, Start, nested installers, MSI, scripts, service/registry/Settings
  and file Explorer system operations.
- Demonstrate automatic trusted target acquisition and one-use approval for
  each class claimed as supported; record unsupported Windows-controlled
  cases explicitly.
- Keep all built-in Windows credential providers accessible; no hooking,
  injecting or credential capture in consent.exe, no disabling secure desktop
  or global UAC bypass.
- Verify the rollback and kill-switch on *all* new capture and privileged
  worker components; preserving the existing EPM service and device access.
- Verify at least: native user reason prompt, RMM pending/deny/approve,
  authorised launch, exact file/operation match, no cross-user confusion,
  replay/expiry, payload replacement, nested child and uninstall/restart.
- Do not label the product as handling "ANY AND ALL UAC PROMPTS" unless
  a documented, audited OS-level integration genuinely passes every case.

## Current implementation vs scope

- Existing Newtest Lenovo EPM: one-time per-signed-EXE elevation with exact
  path, signer/hash, SID/session and temporary admin cleanup. Notepad++ and
  Edge bridge were tested successfully.
- Native `CPUS_CREDUI` tile appeared on the real Windows UAC prompt with
  business-reason input. It cannot automatically identify the original
  arbitrary UAC operation or resume the pending Windows credential flow.
- A preliminary `UacLaunchIntents.cs` class has been added to the feature
  branch for signed EXE prelaunch binding and replay protection. It is only
  a narrow building block, **not universal interception**; do not deploy
  it or imply it meets this requirement.
- Manual EXE path entry is already removed from current UAC tile source;
  CI for that fail-closed version passed (`43736486032`). That source-only
  change has not been deployed to Lenovo.
- No new Lenovo tests or user-action requests are scheduled while this
  coverage gate remains open.
- Original IONOS VPS `ubuntu` / primary *.hi5central.com only. EU
  environment must not be modified.

## References
- Windows UAC implementation and secure desktop:
  https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works
- Credential Providers:
  https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows
- Microsoft Intune EPM supported types and limitations:
  https://learn.microsoft.com/en-us/intune/epm/frequently-asked-questions
  https://learn.microsoft.com/en-us/intune/epm/troubleshoot-known-issues
- Windows Installer elevated managed installs:
  https://learn.microsoft.com/en-us/windows/win32/msi/using-windows-installer-with-uac
- Admin By Request documented UAC fallback scenarios:
  https://docs.adminbyrequest.com/features/elevation-types/run-as-admin-more.htm

## Continuation handoff
The user corrected the assistant: **coverage must be ANY AND ALL UAC prompts,
not only EXEs from Downloads.** This is a product goal, but Windows does not
offer a supported universal credential-provider target-capture/resume API.
The working signed-file EPM/Edge/Explorer integration remains intact. The
native UAC tile source does not ask for manual paths or submit approvals
without a bound target, CI-green but not deployed. A narrower, single-file
prelaunch intent class was created on branch and is NOT integrated/deployed.
This document is the universal coverage release gate and roadmap. Next
implementation work must develop typed request identity and source-specific
adapters, explicit per-operation brokers and comprehensive security tests;
must never claim 100% native UAC interception unsupported by Windows or
ask the user to test a Downloads-only workaround. Original VPS only; EU untouched.
