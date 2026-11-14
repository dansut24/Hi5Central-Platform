# Endpoint Management V2 — manual configuration drift simulation and remediation

Test date: **14 November 2026** (UTC); on the original VPS, Newtest tenant only.
Endpoint: Lenovo `DESKTOP-Q9LTF1M`, Windows Agent `1.0.510`.
Policy: `Windows configuration`, ID `d3015636-baff-4982-9cad-b12b87935f31`, revision 1.
Setting: `windows.filesystem.long_paths_enabled`, desired value `true`.
Only this allowlisted Windows registry value was changed. **No LAPS password, administrator account, firewall, SMB, BitLocker or other policy changed.**

## Before the test

- The Agent was connected; policy Ready, targeted specifically to the Lenovo.
- No conflicting Ready policies, pending endpoint jobs, LAPS jobs or active remote/tool sessions.
- Windows `HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` was **DWORD 1** (enabled).
- The policy-managed rollback backup contained original **DWORD 0**, with `LongPathsWasPresent=1` (the original registry value existed).
- The latest read-only Agent audit had confirmed compliance.

## Live evidence

| Time UTC | Event | Verified result |
| --- | --- | --- |
| 21:38:40 | Read-only preflight, job `6e3cd928-90ea-4147-a910-5a91d3cee2dc` | Current DWORD 1; saved original DWORD 0, presence 1 |
| 21:39:43 | Existing automatic audit, job `9b6b5a09-f6ef-455c-91c5-f8b058b27912` | Observed true (ran **before** drift was introduced) |
| 21:39:54 | Explicitly user-authorised drift simulation, job `79aff8df-93f7-4526-ae4e-ef84dd652624` | Changed **only** LongPathsEnabled DWORD 1 → 0, preserving backup |
| 21:40:36 | New read-only Agent assessment, job `56fb18b7-4b5c-454a-ba79-756bba5cae23` | Observed false, despite desired true; compliance engine returned **drift** |
| 21:41:34 | Explicit QA policy remediation using qualified Apply, job `09bb321f-7195-4d27-b4c1-70f5d25e66c1` | Windows before false, expected true, observed true, status verified |
| 21:42:32 | Automatic post-apply assessment, job `0ff0c7c4-a65c-4490-852c-84b7b258fc30` | Observed true; compliance returned **compliant** |
| 21:43:04 | Independent read-only final registry/backup proof, job `5c062932-efdd-484a-a1de-8de13d4b638f` | Current DWORD 1; saved original DWORD 0; value originally existed; backup preserved |

The automatic monitor's audit at 21:39:43 preceded the simulated manual drift. Therefore **this test proves immediate manual assessment detects drift**, while an automatic reassessment **after remediation** proves restored compliance. It does not claim that the 21:39:43 automatic audit detected the drift.

## Compliance monitoring cadence correction

Discovered that the scheduler sweeps every ten minutes but previously waited 24 hours between successful per-device audits, which could delay discovering externally changed settings.

Changed `services/api/src/rmmEndpointCompliance.js`:
- Introduced `AUTOMATIC_ASSESSMENT_CADENCE_MS = 10 * 60 * 1000`.
- Successful audits are eligible for read-only reassessment after ten minutes, subject to the normal ten-minute scheduler sweep.
- Retained one-hour retry backoff for failed checks and no duplication while queued/claimed.
- Retained the 24-hour **UI freshness bound** to avoid an unverified old result being marked compliant indefinitely.
- Immediate reassessment after a policy Apply or Restore is still supported regardless of a recent successful audit.
- Automatic jobs remain **read-only**; only explicit user-authorised or system QA Apply jobs can modify Windows.

The fix is limited to the Newtest-enabled RMM API scheduler. The feature flag `RMM_ENDPOINT_V2_TENANT=newtest` remains unchanged; no monitoring rollout to other tenants occurred. New API image: `hi5central/rmm-api:endpoint-v2-drift-10m-20261114`. RMM web image unchanged: `hi5central/rmm-web:endpoint-v2-compliance-20261114`.

Regressions test the ten-minute eligibility threshold, the earlier nine-minute non-eligibility, in-flight job guards, revision changes and post-apply checks. Selected 32 test cases passed after the cadence modification.

## Result and next validation

**PASS** — manually introduced drift was independently observed; compliant state was restored through the normal qualified Apply path; the automatic monitor confirmed the restored value; saved original registry state remains intact. No temporary policy was created, and the existing user's Ready policy remains assigned.

Next: browser UI verification of the compliance status and optional longer duration/offline/automatic-drift test on Newtest. Do **not** broaden automatic writes or assume other ADMX settings are enforceable; they remain audit-only until independently qualified.
