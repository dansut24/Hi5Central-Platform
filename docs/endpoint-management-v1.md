# Hi5Central Endpoint Management — Phase 1

## 14 November 2026: implementation and live agent proof

The feature branch includes the RMM configuration editor, tenant-scoped Windows baseline, configuration and native LAPS policy settings, per-setting device/group/user exceptions, risk acceptance and expiry, effective configuration resolution, a Windows agent policy read/apply/verify/restore adapter, manual job submission, and result polling.

**Live rollout status:** not deployed to the RMM web/API. The current live self-service portal API includes newer hotfixes that are absent from the underlying GitHub baseline. Replacing its image without reconciliation could regress the self-service feature. The RMM database already contains tables but has an empty historical migration ledger: do not run the entire migration runner on that DB. Apply only the new migration after backup and source reconciliation.

**No automatic policy enforcement.** The manual agent job adapter reads SMBv1, firewall profiles, and LAPS native backup directory configuration where available. Its only current write adapter is Win32 long-path support. SMBv1, firewall and LAPS are read-only. Exclude withdraws setting management but does not automatically enable a blocked feature or restore any prior state.

### Live test — Newtest Lenovo

- Device: Newtest Lenovo, Windows 11 Pro build 26200, Hi5Central Agent 1.0.506. Original VPS ubuntu only.
- Read-only audit: SMBv1 optional feature disabled, Windows Firewall Domain/Private/Public enabled, long paths disabled, LAPS local configuration registry root present. A LAPS registry root does not establish whether rotation or backup actually works.
- Generated agent job b2c2c770-7282-4e3f-bba5-3d1cb6c5ff27: Windows adapter audit completed.
- Generated agent job 50edc98b-487f-4b73-b4c9-df59fe705e3e: long-path support changed from false to true, verified.
- Generated agent job d28d78e0-c174-4779-9c5d-31ebb3b671e7: long-path support restored from true to original false, verified.
- No SMBv1/firewall/LAPS settings changed. The Lenovo returned to its original long-path state.

### Safeguards

- Tenant-scoped role checks, per-setting exceptions with device > group > assigned-user precedence and conflict reporting.
- High-risk base policy weakening is rejected. High-risk exceptions require explicit acceptance, justification and expiry.
- Windows PowerShell jobs are generated from fixed, allowlisted server code, not user-authored shell strings; only safe long-path writes are enabled.
- Changes require a directly enrolled online agent; queued endpoint jobs expire after 3 minutes, and are cancelled on profile/exception changes. Claimed/in-flight jobs cannot be recalled.
- Agent persists the previous long-path value locally in a protected HKLM location for verified restoration. Restore fails closed if no saved value exists.
- Uses the existing authenticated agent job transport, not signed desired-state bundles. Further security hardening is required before background security enforcement or fleet-wide rollout.
- Future: database migration and live source reconciliation, OS/version capability detection, compliance collection, more read/apply/verify/restore adapters and signed policy versions.

### Native Windows LAPS and Hi5Central password management

Hi5Central can store **LAPS policy configuration** (backup directory, account, age, length, complexity, post-authentication actions and supported AD encryption). Native Windows LAPS only backs up passwords to Microsoft Entra ID or Windows Server Active Directory, not arbitrary third-party RMM vaults. Its active policy source varies by CSP/GPO/local configuration precedence and OS/join prerequisites. The local configuration key is primarily for development and testing.

For standalone workgroup devices, design a separate Hi5Central Local Admin Protection vault: device-local OS-CSPRNG password generation and rotation, authenticated tenant-bound escrow, per-record authenticated encryption, separate key wrapping, recovery acknowledgement, step-up MFA and role restriction for reveals, immutable audit, key rotation and backups, no secrets in telemetry/logs, and strict conflict detection with Windows LAPS. Release only after security review.

### UAC / privilege management (future capability)

Do not intercept or weaken Windows secure UAC desktop. A safe approximation is a Windows shell extension labelled Request Hi5Central elevation, coupled to a trusted, secured broker service. The user supplies a justification, server authorises a particular user/device/file signature/hash/command line for a single short-lived execution, and the broker re-verifies the file and session before launching without exposing administrator credentials. Support explicit approve/deny, single-use tickets, nonce/replay defence, tamper protection, bounded child-process behaviour and complete audit. Existing self-service broker infrastructure is a possible starting point, but elevation permission must be kept strictly separate from ordinary software installations.

### Tests

13 pure resolver and Windows adapter tests pass. RMM frontend and API runtime builds pass. Live Newtest Lenovo Windows audit/apply/restore jobs verified successfully.
