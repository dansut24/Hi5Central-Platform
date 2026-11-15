# Hi5Central EPM — Windows elevation coverage qualification
**15 November 2026, Newtest Lenovo / original IONOS VPS only**

## What was actually completed

1. Introduced typed and immutable request identities in
   `native/epm/Hi5Central.EpmPilot/ElevationOperations.cs`.
   Models signed EXE, Windows Installer MSI, PowerShell script, managed
   Windows action, privileged Explorer file operation, nested child process
   and unmanaged native Windows UAC.
2. Added an explicit support decision to each kind:
   * existing one-use signed-EXE broker only for eligible trusted Explorer,
     browser or managed EXE capture without unapproved arguments;
   * missing MSI, PowerShell, file, system-action or nested-process privileged
     workers fail closed as **not implemented**;
   * unbound/native Windows UAC falls back to built-in Windows credentials.
3. Added a one-use request ledger with tenant, device, Windows user SID,
   Windows session, request ID, target identity and SHA-256, immutable
   binding hash, two-minute TTL, cancellation and replay rejection. Ledger
   is currently a code-level primitive only, **not** a new production API.
4. Added `--coverage-report` to the Windows pilot binary. It reads the
   device's UAC/security posture and reports each operation type without
   changing Windows policies, starting UAC, installing software or modifying
   the existing Hi5Central Agent/broker.
5. Added Windows CI coverage checks, existing desktop handshake and
   broker install/uninstall tests, and explicit verification that
   unsupported native UAC / MSI aren't misrepresented as executable.

## Verified CI and staged diagnostics

- GitHub Windows CI:
  https://github.com/dansut24/Hi5Central-Platform/actions/runs/43738977409
  **SUCCESS**. Build, broker self-tests including typed operation tests,
  Windows coverage probe, and isolated service install/uninstall.
- Windows test artifact ZIP:
  https://downloads.hi5central.com/epm/coverage-qualification-20261115/Hi5Central-EPM-Coverage-Qualification-CI.zip
  SHA256: `8EB2C514C763333FA0FEDFAA425CC08FB320FB2F9E3D4590F81973BD5119F815`.
- Test EXE SHA256:
  `38B771A8505270B51763BA10BB4C816AD7917FCA4972E1AB75B8DE6D667107C1`.
- This EXE is staged as a diagnostic, **not installed** over the working
  Windows EPM service binary.

## Live Newtest Lenovo read-only probe (PASS)

Agent job `708e9012-1855-466a-a003-53bc20e461d8`, completed
15 November 2026 at **17:08:05 UTC** (PowerShell as SYSTEM, no UAC changes).
It downloaded and SHA-256-verified the CI ZIP and portable EXE, ran
`--coverage-report`, parsed its JSON, verified 9 scenario records,
then removed the temporary files.

Observed:
- Operating system: Microsoft Windows NT 10.0.26200.0.
- Windows UAC enabled: **true**.
- Secure desktop enabled: **true**.
- Standard user prompt policy: **3** (credentials).
- AppInfo Windows service: **Running**.
- Windows Installer service: **Stopped** at this instant; demand-start
  state alone does not imply an error.
- Experimental Hi5Central CPUS_CREDUI tile: **not registered** (timed
  rollback removed it).
- Existing EPM broker: **Running**; installed SHA256
  `B18D5D70A5035853E9CD1D21178B34A03FBAB60767896DDA451CF7352C152AA8`.
- Main Hi5Central Agent: **Running**.

The report explicitly classified:
- Explorer signed-EXE and Edge/Chrome downloaded-EXE:
  **qualified existing file-bound execution route**.
- Unmanaged native UAC: **Windows UAC fallback**.
- MSI, signed scripts, nested child process:
  **worker not implemented**.
- Windows Settings, services/registry/tasks, protected file operations:
  **operation-specific broker required**.

This is a **live capability / safety report**, NOT a successful MSI,
PowerShell, Windows Settings or universal UAC elevation test.

## Security tests in Windows CI

- Refuse cross-user SID, changed signer/hash and wrong target.
- Refuse replay, expired, cancelled or modified one-use identity.
- Refuse unapproved executable arguments and arbitrary nested child.
- Refuse UNC and traversal-style paths.
- Refuse generic native UAC request with no trusted target.
- Refuse elevated MSI, script, system action or file operation without a
  separately qualified worker.
- Keep existing Windows built-in credential provider and secure desktop.

## Remaining work BEFORE another employee end-to-end test

The user explicitly requires the broadest practical coverage, no manual
paths, and wants to avoid additional Lenovo end-user testing until the
implementation meets the agreed scope. This report alone does not qualify
a cross-scenario elevation experience.

Implement and independently verify:
1. Trusted per-invocation automatic target/operation capture for all
   claimed supported entry points. No universal arbitrary-native-UAC
   interception API is documented by Microsoft.
2. MSI worker with package trust and exact install/repair/uninstall
   operation and one-use RMM approval; independent Windows test.
3. PowerShell/script worker with pinned content and tight arguments;
   prevent arbitrary administrator shell use.
4. Policy-defined Windows service, registry, scheduled task, Windows
   Settings and protected-file operation workers, each with explicit
   resource/action binding and rollback.
5. Nested child process policy, job lifecycle, safety limits.
6. Combined reason-only employee prompt, Newtest technician approval,
   approval notification, reject/expire/replay and cleanup tests.
7. Preserve normal Windows UAC for unsupported/unbound actions, without
   disabling secure desktop, injecting administrator credentials or
   filtering Windows credential providers.

Do **not** market or label the feature as handling ANY AND ALL UAC
prompts until the supported coverage matrix has concrete verified evidence.

## Chat continuation summary

On 15 November user asked to continue implementation toward testing broad
Hi5Central EPM across arbitrary UAC/elevation scenarios. In this turn
implemented typed operation identities, fail-closed approval-intent ledger,
Windows CI security tests and a read-only coverage probe. Windows CI run
43738977409 PASS. Ran read-only RMM job on Newtest Lenovo; report confirms
healthy UAC/secure desktop and running Agent/EPM broker, and that MSI,
scripts, Windows operations, children and arbitrary native UAC remain
unsupported. No new EPM service binary, UAC tile or Windows policy was
installed. Next implementation must add actual per-operation execution
workers and authenticated capture to enable broad end-to-end user testing.
Only original VPS ubuntu/primary domains, never EU.
