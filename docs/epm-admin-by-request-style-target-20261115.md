# Hi5Central Endpoint Privilege Management — target experience
**Date:** 15 November 2026 | **Scope:** RMM Endpoint Security / Newtest Windows pilot
**Reference product:** Admin By Request (feature reference, not an instruction to clone UI/branding)

## Decision
Model the future Hi5Central EPM on targeted, user-initiated application elevation,
with an independently approved, auditable *temporary admin session* offered only as
a separate policy-governed feature.

The **Company Portal is not the application installation source** for this flow.
Users may download software themselves. The Portal is a companion for requests,
approval notifications, retry, policy explanations and history; IT administers
policies and decisions from RMM.

### Acceptance journey
1. A standard user downloads a signed Notepad++ EXE in Edge.
2. User opens the downloaded file. Where a supported Windows integration can
   identify the elevation trigger, Hi5Central offers its own reason/request dialog
   before elevated execution. **Do not claim full UAC interception until verified
   on supported Windows versions; never patch UAC or Windows binaries.**
3. The right-click "Run with Hi5Central admin" verb must always remain as a
   predictable fallback for EXE (later: MSI, MSC, CPL and supported script workflows).
4. User submits business justification; agent verifies identity, local session,
   file SHA-256, Authenticode signer/certificate and exact path. Broker does not
   stage or duplicate large installers under ProgramData.
5. IT sees a dedicated **Endpoint Security > Elevation Requests** record with
   user/device, publisher, hash, signer, requested path and reason.
6. Technician approves once, denies or applies a pre-established scoped policy.
   Default approvals must be short lived and bound to the original identity/file.
7. User receives a Windows toast with the action **Run approved file**, and can
   also re-open the file via Explorer or Company Portal. On retry, re-check the
   same file handle/identity; no general command or administrator token is issued
   to the user.
8. The approved process runs visibly, interactively, on the requesting user's
   desktop. Do not equate CreateProcess success with installer success.
9. Record: approved, redeemed, process started, process ended, exit code,
   duration, child-process/job completion and observed installed-version change
   (if applicable). Non-zero exit/unknown install result must not appear as
   successful installation.
10. Any elevation identity, handles, grants and runtime ACL changes are cleaned
    up and auditable. User remains a standard user at all times for this flow.

### Architecture
- **RMM Policy/approval service**: independent of App Portal software assignments;
  tenant+device+requester+file binding, one-time replay protection, RBAC, overrides,
  history and audit, immutable decision notes. Keep LAPS and Windows endpoint policy
  management separate; support policy unassignment/removal.
- **Windows SYSTEM service/broker**: signed, least-privilege local IPC protocol;
  server trusts the OS-authenticated requesting user/session, not caller-provided
  SID; allowlist restricted operation types; no generic SYSTEM command executor.
- **Interactive user companion**: requests, Windows notifications, status and
  retry; desktop launch uses a supported, audited Windows security model. Preserve
  the requester's desktop context so installer UI works, not a detached account
  profile with inaccessible interactive window station.
- **File identity**: hash + authenticode signer, path, session, user, expiry;
  verify exact executable again while denying modifications at launch; deny
  execution on network/share/reparse ambiguity until separately qualified.
- **Visibility**: server-side lifecycle and Windows exit-code telemetry;
  process creation is **not** proof of installation. Timeouts must be explicit
  and must not kill a legitimate installer without corresponding status/audit.

### Separate modes
1. **Application Elevation** (priority): one executable only, standard user
   remains standard, approve/reject/pre-approve, notifications and precise audit.
2. **Admin Session** (future): user requests a bounded, time-limited session
   with explicit approval, countdown, continuous audit, manual early end,
   emergency kill, reversible group/policy state. Higher risk, separate controls.
3. **Company Portal** (companion): show requests and installed software, not
   mandatory to execute a user-downloaded installer.

### Policy features to add
- Require approval, require reason, automatically allow trusted app/signer/hash,
  block high-risk targets, allow explicit device/user/group exceptions.
- Tenant-wide defaults and per-device/user/group scope; approval expiry,
  signer/hash rules, audit retention, alerts, remote revoke and policy rollback.
- Integrate with Hi5Central software catalogue qualification, inventory,
  vulnerability intelligence and ITSM tickets but **never conflate** catalogue
  assignments with UAC/application elevation.
- Browser, command interpreters, security tools and script engines remain blocked
  by default in the first production release. A browser (Edge) elevation request
  may be shown as denied with a policy reason; it is not automatically safe.

### Windows integration investigation
- Qualify the supported Explorer shell verb first.
- Investigate Windows-supported elevation/UAC integration in an isolated QA
  endpoint: downloaded EXE double-click, UAC-triggered launches, MSI, Settings,
  update helpers, secure desktop and Intune/Autopilot-managed identities.
- Do not replace system components, alter UAC policy globally, inject credentials,
  hook undocumented secure-desktop processes or add the requester permanently to
  Administrators.
- Document each supported trigger with positive, rejection and rollback tests;
  retain standard Windows UAC if Hi5Central is unavailable.

### Pilot status as of 15 Nov 2026
- Newtest Lenovo Agent 1.0.510; original VPS only (ubuntu,
  /opt/hi5central/runtime, *.hi5central.com); NEVER touch EU.
- Existing feature branch: `feature/epm-file-elevation-pilot-20261114`.
- Newtest request `6f2f3735-3992-4cb4-95a6-014494a1584d` approved and
  redeemed at 09:29 but Notepad++ 8.9.9.1 installer never completed.
- On Lenovo: no Notepad++ installer process or temporary H5EP account remained
  at 09:37; installed Notepad++ still 8.9.8.1.
- Current isolated temporary-local-admin launcher is NOT qualified for visible
  interactive execution. Its process-telemetry extension has Windows CI green
  and RMM backend/frontend deployed but requires endpoint update for actual data.
- Do **not** continue promoting temporary-account launcher as final EPM design.
  Investigate and qualify interactive desktop/session execution architecture.
- Keep self-service independent broker unchanged; preserve old approval records.

### Required next test gates
1. Trace Windows process lifetime/exit and user-session/desktop ACL status.
2. Qualify a lightweight **signed harmless GUI test** that visibly displays in
   the user's interactive desktop; reject non-matching/altered files.
3. Install signed Notepad++ 8.9.9.1 EXE from original Downloads without a
   black window, with request reason, approval, toast and one-time use.
4. Confirm package version transition 8.9.8.1 → 8.9.9.1 and no orphan H5EP
   user or broker session artifacts.
5. Test denied, expired, replay, file replacement, interrupted network,
   service stop, installer child-process creation and cleanup.
6. Only then investigate UAC-triggered workflow beyond Explorer shell action.

## Public feature references
- https://docs.adminbyrequest.com/features/run-as-admin.htm
- https://docs.adminbyrequest.com/endpoints/Windows/ui.htm
- https://docs.adminbyrequest.com/portal/settings/windows.htm
- https://docs.adminbyrequest.com/features/admin-session.htm
- https://docs.adminbyrequest.com/portal/auditlog.htm

## Chat continuation summary
User clarified end-goal on 15 November 2026: Hi5Central EPM should behave
similarly to Admin By Request. Prioritize downloaded-executable interactive
application elevation with justification, RMM approval, notification,
process-only privilege, safe Windows UAC/shell integration and full audit.
Company Portal is secondary. Avoid broad temporary-local-admin session for
one application; keep a separate future Admin Session feature. Newtest-only
Windows pilot has approval working but installer UI/process completion not yet
qualified. RMM process lifecycle telemetry deployed, Windows update pending
endpoint qualification. Use original VPS only, not EU.
