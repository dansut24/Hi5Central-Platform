# Hi5Central Mobile — 13 November 2026 engineering handover

## Latest user confirmation
- ITSM v0.2.0 is installed on iPhone. It **fixed the black top/bottom bars and safe-area layout**. Screenshot showed Service Desk dashboard, four metrics, native graphs and floating iOS tab bar.
- User requested ITSM "V3.0" feature work and asked if subscriptions to both ITSM + RMM should be available in a single iPhone application.

## Decisions
- Implement **ITSM v0.3.0** standalone as the next milestone.
- Test an optional **unified Hi5Central Mobile alpha** as a THIRD native IPA with both ITSM and RMM.
- Keep the working original RMM app (v0.5.16) and ITSM app; do not replace either or modify VPS, Agent, streaming, TURN or codec logic.
- Shared platform login/MFA; actual session `platformAccess.itsm` and `platformAccess.rmm` plus ITSM `workspaceAccess` determine module visibility. Native backend checks remain authoritative.
- ITSM-only: ITSM workspace; RMM-only: RMM workspace; both: native picker in the shell.
- Reuse the real RMM WebRTC viewer in the unified app, not a website wrapper.
- Combined app's new bundle ID: `com.hi5central.mobile`; standalone IDs unchanged.

## Verified Github builds and artifacts
- Standalone ITSM v0.3.0: branch `feature/itsm-ios-v030-record-workflows`, run **43385201468**, GREEN; artifact `Hi5CentralITSM-iOS-v0.3.0-fullscreen-native`.
- Unified combined iOS alpha v0.1.0: branch `feature/hi5central-ios-unified-v010`, final run **43386388903**, GREEN; artifact `Hi5CentralMobile-iOS-v0.1.0-ITSM-RMM`.
- The final unified branch also compiled the standalone ITSM job successfully as run **43386385591**.
- Github links:
  - https://github.com/dansut24/Hi5Central-Platform/actions/runs/43385201468
  - https://github.com/dansut24/Hi5Central-Platform/actions/runs/43386388903

## Standalone ITSM v0.3.0 content
- Native create-forms for Incident/Problem/Change using existing `POST /api/v1/itsm-records`.
- Required summary (3–240 chars), description, requester directory selection, team, technician, priority, service, category.
- Native record edit screen for summary, description, service and category using `PATCH /api/v1/itsm-records/:reference`.
- On success, refreshes the records and reporting view.
- Improves 30-day dashboard chart on tenants with only one date (compact count instead of sparse single-point line).
- Retains ITSM v0.2.0 full-screen launch fix and People/CMDB/Projects/Calendar/Tasks/Approvals/Knowledge.
- Existing note and assignment actions unchanged.
- Does NOT yet complete file uploads/downloads, Service Catalogue request forms, rich-text editor, versioned resolution lifecycle, UAT/Test env switching, passkeys or real APNs push. Do not claim those are present.

## Unified alpha implementation
- Source `apps/hi5central-ios/Sources/UnifiedMobileAuth.swift`: existing API login, MFA, session validation with product flags, no credential persistence.
- `Hi5CentralMobileApp.swift`: switcher and module-gated navigation, original RMM native viewer fullScreenCover, per-product search and refresh, existing ITSM screens.
- `UnifiedMobileLogin.swift`: native secure onboarding, MFA and recovery code handling.
- `apps/hi5central-ios/project.yml`: includes both actual SwiftUI module source folders; WebRTC 156.0.0 SPM as originally used by RMM; compiled with HI5CENTRAL_UNIFIED flag to exclude only original app entrypoints. No separate backend.
- `apps/hi5central-ios/Sources/LaunchScreen.storyboard`: full-screen safe area to avoid the earlier black bars.
- Native deep link `hi5central://device/<deviceUUID>` from a CMDB linked device to a device in authorised native RMM inventory. Fails closed if no RMM permission/visible device.
- `apps/hi5central-ios/README.md`: testing.
- `.github/workflows/hi5central-ios-unified-ipa.yml`: builds unsigned IPA on GitHub macOS, verifies bundle ID/version and launch storyboard.
- Integration after compilation STILL MUST BE VERIFIED ON REAL iPHONE.

## Recommended immediate tests
1. Install unified alpha IPA alongside the two standalone apps using Sideloadly, not over them.
2. Sign in to a company with ITSM + RMM and complete mandatory MFA.
3. Verify picker and native Service Desk and RMM module screens; remote Lenovo session and automatic Windows keyboard focus.
4. Test CMDB linked device (if such a link exists) -> full native RMM device detail and viewer.
5. Confirm ITSM-only tenant only sees ITSM, RMM-only tenant only RMM, restricted user sees correct permissions, requester denied staff app access.
6. Test native record create/edit in v0.3.0. Verify on the web that exactly one record is created and updates persist. Avoid creating production records unless authorised.
7. Sign out, relaunch, ensure module access and tenant information are cleared.
8. If unified app has issues, uninstall only the unified alpha; standalone ITSM v0.2.0 and RMM v0.5.16 are the known-good rollback.

## Next work
- Test dual-product sign-in and module switch against real tenant, fix any API auth/origin problems.
- True common product shell, notification centre, linked-record/device, ITSM resolution lifecycle using versioned `/api/v1/itsm-actions/:reference/resolve` once version is exposed by record API.
- Service Request catalogue dynamic forms and comments, verified attachments endpoints, task and approval workflow tests, accessible/dark UI, APNs / passkeys with appropriate Apple entitlements.
- Align combined app's user session and native refresh behaviour across module permissions.
