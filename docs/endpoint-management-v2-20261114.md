# Endpoint Management V2 — policy compliance pilot

Date: 14 November 2026. Environment: original Hi5Central production VPS, Newtest tenant only.
Feature branch: `feature/endpoint-setting-exceptions-20261114`.

## Implemented

The existing policy catalogue, per-setting exclusion/override, scope assignment, local administrator vault and verified Windows apply/restore paths remain intact. V2 adds:

- A **per-profile compliance API** and dashboard showing assigned devices, compliance, drift, pending, offline, conflict, partial, unsupported and excluded states.
- `GET /api/v1/rmm/endpoint-management/profiles/:id/compliance` and authenticated `POST .../compliance/assess` for one or multiple assigned devices.
- A scheduler on the RMM API, explicitly enabled only by `RMM_ENDPOINT_V2_TENANT=newtest`. Every ten minutes it queues **read-only** Windows policy audits for online, targeted devices; queued and claimed jobs are not duplicated. Disconnected devices are not contacted, and are re-evaluated on a future sweep after reconnecting. No automatic Windows writes or reboots.
- Reliable compliance calculation from the **actual Agent's authenticated, durable job result** and effective desired settings. The assessment signature includes policy revision and resolved per-setting exceptions. Old, missing, stale, failed or wrong-revision results never count as compliant.
- A write or restore invalidates a previous audit immediately; the automatic scheduler queues another read-only assessment even if the old audit was less than 24 hours old. Failed audits may retry after one hour rather than flooding the Agent.
- Partial or unsupported settings are explicitly flagged rather than being falsely counted as compliant; Windows LAPS policy preview, firewall and SMBv1 remain audit-only. Win32 long-path setting remains the sole qualified write-and-restore adapter.
- A strengthened `LongPathsEnabled` restoration adapter that captures the **original DWORD and whether the registry value existed**. Removal restores the original state and verifies it before discarding the per-profile backup; previously stored legacy backups remain compatible.
- Original policy-withdrawal safety check remains: a previously applied Windows setting must be verified restored before it or its profile can be removed. Claimed writes block removal until resolved. Historical audit is preserved.

Security: every API endpoint requires the existing tenant session and `rmm.policies.view` or `rmm.policies.manage` permission. The scheduler is scoped only to Newtest. Audit commands are generated from a strict server-side allowlist and do not execute client-supplied PowerShell. LAPS encryption, vault controls, password rotation and the independent self-service broker were not modified.

## Live QA on Newtest Lenovo

Device: `DESKTOP-Q9LTF1M`, Agent 1.0.510, inventory ID `a869f423-c3fa-4df9-96eb-651787c6b162`.
Temporary system-QA profile: `32070cee-f728-4052-be98-03bacef45f0e` (one safe Windows setting, exact-device scope). Created with a system QA audit rather than impersonating a technician session. No unrelated tenant policy was assigned.

| Timestamp UTC | Evidence | Windows result |
| --- | --- | --- |
| 21:11:33 | Automatically queued read-only Agent job `e6e1a137-caee-4bf6-a4c1-1178189023e8` | LongPathsEnabled false; desired true: **drift** |
| 21:12:41 | Authorised QA apply job `188fca3f-f51c-4c73-a80e-78ebc1232675` | Before false, expected true, observed true, verified |
| 21:13:23 | Separate read-only audit job `aaf77b3b-bb38-4745-8cbc-431d37a89635` | Observed true; **compliant** |
| 21:14:42 | Authorised QA restore job `5550c351-e153-4412-8c07-35ad928d65fe` | Before true, expected false, observed false, verified |
| 21:15:39 | Independent read-only Windows registry/backup inspection `d5dc821f-4f63-4719-8f64-60a582b9f28b` | Original registry DWORD **0** present; policy-backup value and presence metadata both absent |

The profile-withdrawal guard was exercised against real Agent results: one outstanding restoration after apply; zero after verified restore. The temporary profile was **soft-archived**, leaving six historical audit records and no active test profile. No LAPS password, Windows administrator, firewall, SMB, BitLocker or Windows Update setting was changed. Agent remained connected.

Compliance evaluation from the actual recorded jobs:
`drift → pending after apply → compliant after recheck → pending after restore`.
The offline and stale conditions have automated coverage but **were not induced by physically disconnecting the Lenovo**.

## Deployment details

- RMM API image: `hi5central/rmm-api:endpoint-v2-postchange-monitor-20261114`
- RMM web image: `hi5central/rmm-web:endpoint-v2-compliance-20261114`
- Compose is `/opt/hi5central/runtime/compose.yml`, original VPS only; `RMM_ENDPOINT_V2_TENANT=newtest` configured only for RMM API.
- Backup before deployment: `/opt/hi5central/runtime/backups/endpoint-v2-20261114/endpoint-v2-pre.dump` and `compose.before-v2.yml`. No new database schema needed; audit receipts remain in `rmm_agent_jobs` and `rmm_endpoint_policy_history`.
- 51 automation tests initially passed; post-change monitor safety regression added, with all 49 selected final tests passing. Vite web and API runtime builds passed.
- Public Newtest RMM HTTP 200, unauthenticated compliance and policy endpoints HTTP 401, both RMM containers healthy, Agent 1.0.510 online and `Hi5Recovery` still `removed` from the previous validated test.

## Next UAT and rollout

1. Sign into `https://newtest-rmm.hi5central.com` → Configure → Endpoint management → Policies & compliance.
2. Create a **Configuration profile**, scope it to **DESKTOP-Q9LTF1M**, choose Win32 long paths and set Ready. The read-only monitor will create a compliance assessment within the next sweep; "Check assigned devices" performs an immediate authenticated check.
3. Use Apply to change only this allowlisted setting and watch the status transition after reassessment. Use Restore original before disabling, unassigning, changing the scope or removing the policy. Enter the exact name and reason for removal.
4. Validate group/user targeting, exclusions/overrides, policy conflicts and offline reconnect on disposable test profiles; do **not** change native Windows LAPS, firewall, SMBv1 or security policy until corresponding managed write-and-restore adapters are separately qualified.
5. Later expansion: policy version/assignment conflict priority, MDM/GPO owner-awareness, qualification of additional safe settings, read-only assessments across multiple test devices, optional approved remediation schedules, and UAT multi-tenant rollout.

Limitation: the authenticated browser UI has been built/deployed and its APIs are protected; a human browser-session click-through on the newly deployed compliance screen has **not yet been performed**. The Windows lifecycle above was performed as an audited, system-initiated QA fixture (not by masquerading as a user session).

Final V2 verification: 52 automated regression tests passed; live API/web health both 200, unauthenticated compliance assessment POST HTTP 401, zero automatic write jobs and one completed automatic read-only audit job. Final API image `hi5central/rmm-api:endpoint-v2-postchange-monitor-20261114`, web image `hi5central/rmm-web:endpoint-v2-compliance-20261114`; the second API build specifically fixes automatic rescan after a recent policy apply or restore. Newtest Agent 1.0.510 remains connected. Original long-path registry value = DWORD 0 and no temporary backup remains. Original LAPS recovery account remains in its user-confirmed `removed` state.
