# Hi5Central Endpoint Privilege Management — initial approval workflow

Date: 14 November 2026. Platform: original production VPS only; pilot tenant Newtest.

## Windows UAC integration boundary

Windows UAC consent/credential UI on the secure desktop is owned by Windows. Third-party software cannot safely add a textbox or an approval button inside the standard secure desktop UAC dialog. The Hi5Central solution is **a separate, branded, pre-elevation request** on the user's normal desktop. Do NOT disable UAC, remote-control Credential UI to fill in administrator passwords, hook Consent.exe, tamper with AppInfo, or make every user a local administrator.

Microsoft's Endpoint Privilege Management uses a similar separate support-approved/file-elevation experience, sometimes accessed with a right-click menu. The secure desktop and Windows credential prompt remain Windows-controlled when used. Sources:
- https://learn.microsoft.com/en-gb/windows/security/application-security/application-control/user-account-control/how-it-works
- https://learn.microsoft.com/en-us/intune/epm/manage-elevation-settings
- https://learn.microsoft.com/en-us/intune/epm/create-elevation-rules

## Phase 1: Company Portal approval reasons — implemented in source

The existing Windows Hi5Central Company Portal is already an unprivileged Avalonia application. Its named-pipe broker impersonates the caller and obtains the Windows user SID from the actual OS token. It forwards approved backend requests over Agent authentication without exposing privileged Agent credentials to the unprivileged process. The existing patching path validates the published application revision and its package trust properties.

New request flow:
1. Configure a published assigned application with intent `approval_required` (Device/User/Group/Site/Estate scope).
2. Standard Windows user selects **Request approval** in Company Portal.
3. A branded, non-UAC modal asks why they need the software; the client requires 20–2000 characters, sends only an application ID and reason through the existing authenticated named pipe, and supports Cancel.
4. Backend independently enforces reason length and assigned/immutable revision; pending request is stored with trusted Windows SID. **No installer runs yet.**
5. RMM → App Portal → Approval requests displays requester, application and full business justification; approver enters their own 10–2000-character decision reason. RBAC `rmm.software.manage`, tenant session, current assignment and immutable revision are enforced by API.
6. On approval, an atomic pending→approved claim prevents two administrators dispatching the same install. Only the approved, published revision is dispatched through the existing qualified installer/PatchHost path. Known dispatch failures may return request to pending. An uncertain dispatch leaves status approved and is shown as a review-required item; it must not be blindly replayed.
7. On rejection no job is dispatched; the user sees request declined in the Company Portal. Both request reason and admin decision note are retained in request history.

Windows Agent v1.0.510 **already forwards** an optional `reason` field in the named-pipe request to the authenticated API. No native Agent change is required for this phase; the new Company Portal desktop client is the component requiring a fresh Windows build.

Scope note: this phase covers managed Company Portal software installs; it does **not** capture arbitrary Windows UAC prompts.

## Phase 2: generalized elevation by approval — design, NOT implemented

- Add Explorer right-click action **Run with Hi5Central approval** for `.exe`/`.msi` and a companion Hi5Central user dialog (reason, request status, expiry). Alternatively initiate through Company Portal. This must run on the normal desktop before the process invokes Windows UAC.
- Agent independently authenticates the caller SID/session and securely opens the exact requested file, calculates SHA-256, checks Authenticode signer, path and file type, and registers a pending request. Script interpreters, arbitrary PowerShell/CMD, executable arguments allowing command injection, remote UNC paths, reparse points and unsigned binaries are denied by default.
- Tenant policy determines **Deny**, **Support approval**, **User-confirmed**, or narrow **Automatic** for trusted application allowlists. Default deny for unknown files; scope to device/user/group and policy revision, immutable signer/hash and allowed arguments.
- Review queue displays device, requesting user, business justification, publisher, signature, SHA-256, path and risk flags. Approvals must be one-time/short-expiry and bound to exact user SID, endpoint, file hash, rule revision and arguments. Separate `rmm.security.elevation.approve` RBAC, dual approval for high risk, audit and optional ITSM ticket/notifications.
- A signed, least-privilege native broker service executes **only** an authorised verified specific action. Immediately before launching, verify the file is unchanged and bound approval has not expired or been consumed. Use trusted storage/secure handle/path validation and minimize token rights. No generic SYSTEM shell execution, no unrestricted privilege token and no added permanent Administrators membership.
- Keep Windows UAC enabled. Avoid conflating a policy-approved managed software deployment by SYSTEM with a universal UAC bypass. Remote control of UAC should continue to work independently of the approval feature.
- Support logout, offline queuing (but no expiry bypass), cancellation, rejection, fail-closed restart, one-time redemption, notifications and full audits.

## Validation and rollout

- Node/Vite API and RMM UI builds and regression tests must pass.
- Native Windows Company Portal Avalonia .NET 8 build must pass in GitHub Actions on the feature branch; distribute a versioned signed/verified installer before enabling mandatory business reasons in production.
- First pilot in Newtest: mark one already published, low-risk application as `approval_required` for only the Lenovo, send a reason from the Company Portal, review and reject it first (**no install**), then submit again and approve; verify package/revision hash and status. Restore the prior assignment afterward.
- Non-Newtest customers must remain untouched; never change the separate EU host.

## Newtest production canary — live delivery

Implemented a compatibility gate `RMM_APP_PORTAL_APPROVAL_REASON_TENANT=newtest` in `rmm-api`. Mandatory 20–2000-character employee reason and 10–2000-character technician decision reason apply **only to Newtest** until other customers receive updated Company Portal desktop binaries. Existing normal install assignments are unaffected. The admin bundle exposes `approvalReasonRequired`, and the RMM UI uses that to avoid disabling old requests on unaffected tenants.

GitHub App Portal CI run `43645877848` Windows and Linux **success**, macOS **cancelled**. Windows release artifact `Hi5Central-App-Portal-Windows` 14134002260, self-contained 44,724,980-byte EXE, SHA-256 `801844660fab1d12a73d18a9e51bd169a2015252aefc786faf9dc52556543788`, URL:
`https://downloads.hi5central.com/app-portal/approval-v1-20261114/Hi5CentralAppPortal.exe`
This binary is staged for testing, not silently deployed to employee devices.

API image `hi5central/rmm-api:epm-portal-approvals-20261114`; RMM web image `hi5central/rmm-web:epm-portal-approvals-20261114`; both deployed to the **original primary VPS** with Newtest-only approval reason gate. API and web healthy, public web HTTP 200, unauthenticated App Portal/decision routes HTTP 401; Agent 1.0.510 connected. Zero live outstanding approval requests and zero approval-required assignments at the deployment check. No app-install jobs triggered. Backup `/opt/hi5central/runtime/backups/epm-approval-20261114` retains predeployment compose and App Portal database table dump. The existing LAPS account remains `removed` as previously confirmed.

Pilot instructions: in Newtest App Portal, choose a published uninstalled app and set a **Device** assignment to `approval_required` for Lenovo Agent ID `8b416bc2-ba5a-42d0-9b43-777a6f47af20`. Launch the staged Company Portal as a normal Windows user, click **Request approval**, type at least 20 characters, then check RMM's Approval requests. Reject first with a reason (no elevated install). Afterwards, if intentionally approved, only that published revision is dispatched using existing App Portal/PatchHost security. Restore original assignment after test. Do not assume an already-installed app will show the request option.

Security boundary: **normal Windows UAC still appears** for directly launched arbitrary applications; this feature does not intercept Consent.exe, replace secure desktop prompts or elevate a UAC dialog. File-specific right-click elevation remains separate future work.
