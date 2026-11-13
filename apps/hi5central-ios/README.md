# Hi5Central Mobile — combined native ITSM + RMM alpha

Version 0.1.0. This is a **third, separate unsigned IPA**; it does not
replace the proven Hi5Central ITSM or RMM apps on your iPhone.

## Design
- One login and mandatory MFA on the original `api.hi5central.com`.
- Module selection uses server session `platformAccess.itsm`, `platformAccess.rmm`,
  and ITSM `access.workspaceAccess`. Never rely on an iOS-only entitlement toggle.
- One tenant per signed-in session, no cross-tenant device/session leakage.
- All native ITSM 0.3 screens are reused directly from `apps/itsm-ios/Sources`.
- All native RMM 0.5.16 screens, tools, keyboard, native WebRTC codecs and
  viewer are reused directly from `apps/rmm-ios/Sources`.
- WebRTC 156.0.0 SPM dependency remains unchanged; no TURN or VPS changes.
- Unified app ID `com.hi5central.mobile`, URL scheme `hi5central://`.
- Standalone apps retain their original IDs and independent build jobs.

## Test sequence
1. Sideload `Hi5CentralMobile-iOS-unified-native.ipa` alongside both apps.
2. Sign in with a company licensed for **both** ITSM and RMM.
3. Confirm both modules appear and accessible screens match their standalone apps.
4. Start one remote session on Lenovo; confirm native video and iOS keyboard
   including automatically opening when Windows fields gain focus.
5. Switch to ITSM; verify Incidents, Notes, Tasks and Knowledge. Switch back and
   ensure RMM devices remain populated and streaming still works.
6. Test separate ITSM-only and RMM-only tenants: unavailable modules must not
   be displayed or accessible via deep link.
7. Test a restricted technician and a requester user. Requesters must not
   access either staff workspace.
8. Sign out. Ensure the combined app no longer presents tenant data.

## Caveats
- Shared session and permissions are required. A **compiled** IPA does not
  prove all live APIs, permissions, remote viewer and deep-link behaviours work.
- The combined app uses ITSM and RMM's native screens as built, so advanced
  UI polish, attachment transfers, passkeys, APNs, UAT/Test environment routing
  and Service Request catalogue fulfilment remain follow-up work.
- No deployment of the VPS API, RMM Agent, TURN server or separate apps is needed.
