# Hi5Central Mobile v0.5.0 — privacy and foreground alerts

Branch: feature/hi5central-ios-v050-privacy-notifications
IPA artifact: Hi5CentralMobile-iOS-v0.5.0-privacy-notifications
Built on v0.4 native record workflow branch. Bundle: com.hi5central.mobile.

## Implemented
- Optional per-tenant Face ID/Touch ID/device-passcode app lock using LocalAuthentication.
- Lock on background; closing active remote viewer and detail sheets when this optional setting is enabled.
- Device authentication unlocks only an already valid server session. It does NOT replace mandatory MFA, act as a passkey or silently sign into the backend.
- Immediate clearing of ITSM and RMM tenant-scoped in-memory data on sign-out.
- Authorised custom URL deep links for ITSM records and RMM devices, with tenant matching, record reference/UUID validation, and permission-bound inventory lookup.
- Pending deep links are held during sign-in/app lock and resolved only after workspace is available.
- Opt-in native iPhone local notifications for new ITSM in-app notices and RMM agent offline transitions while the app is in the foreground, with 60-second polling.
- Notification tap routes to authorised native record/device views. Local test alert available in More > Privacy & notifications.
- Preserves v0.4 native workflow actions and untouched remote streaming/codec engine.

## Not yet supported
- True APNs background/closed-app remote push: requires Apple push entitlements, a signed provisioned app and secure backend token registration, rotation and delivery. Sideloadly unsigned builds are not a substitute.
- WebAuthn/passkey authentication: requires credential endpoints and an associated domain plus provisioning. Optional app lock is NOT passkey sign-in.
- Attachment upload/download and native Service Request comments remain blocked on absent verified API operations.

## Device QA
1. Install IPA on top of v0.4. Keep standalone apps installed.
2. Enrol per-company Face ID/passcode from More, background app and unlock. Confirm remote session closes when optional lock is enabled.
3. Sign out and switch tenants; ensure prior records/devices are not visible.
4. Enable foreground notifications in More; use test alert and tap it.
5. Test hi5central://record/INC-xxxxx?tenant=company and device URL. Links for other tenants must be blocked.
6. Wait for a genuinely new ITSM notification or RMM offline transition while foregrounded; confirm native alert and drilldown.
7. Retest incident resolution and ITSM-to-RMM native viewer/keyboard/codec.
8. Build passing does not replace live-device tests.
