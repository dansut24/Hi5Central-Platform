# Hi5Central Mobile — v0.2.0 unified native navigation

Branch: feature/hi5central-ios-v020-unified-navigation

The combined app (com.hi5central.mobile) is a third, separately sideloadable
iPhone application. Standalone Hi5Central ITSM and RMM apps remain intact.

## Implemented in v0.2.0

- Single native tab bar replaces the permanent top ITSM/RMM switcher:
  - Both products, combined focus: Home, Records, Devices, Tasks, More.
  - ITSM-only, or ITSM focus: Home, Records, Tasks, Knowledge, More.
  - RMM-only, or RMM focus: Home, Devices, Alerts, Tools, More.
- Combined Home reports real open ITSM work, accessible tasks, online/offline
  RMM devices, and recent tickets and devices requiring attention. Charts use
  permission-filtered data, never fabricated historical trends.
- Global Search across ITSM records, tasks, knowledge, People, CMDB, Projects
  and RMM devices; the results are limited to authorised modules.
- More provides ITSM and RMM modules, unified theme and sign-out, and optional
  Combined / Service Desk / Remote Monitoring navigation preference.
  Navigation preference never overrides tenant product entitlements.
- ITSM -> RMM: A record can search authorised RMM devices and open a native
  device management panel and remote session. Explicit linkedDeviceId,
  rmmDeviceId or deviceId values are considered links ONLY if they match the
  authenticated tenant's RMM device list. Otherwise choose manually; no
  association is guessed. Existing CMDB hi5central://device/uuid link remains.
- Remote viewer unchanged: the native WebRTC/codec/Windows keyboard code from
  the previously working RMM app is reused unmodified.
- No VPS API, Windows Agent, standalone RMM or standalone ITSM deployment.

## Build and install

Workflow: .github/workflows/hi5central-ios-unified-ipa.yml
Artifact: Hi5CentralMobile-iOS-v0.2.0-unified-navigation
IPA inside artifact: Hi5CentralMobile-iOS-unified-native.ipa

Install using Sideloadly. This upgrades the combined v0.1.0 installation
without replacing the separate ITSM and RMM apps. GitHub green confirms only
compilation and packaging; real-device runtime tests are required.

## Required iPhone test matrix

1. Dual-product tenant: tenant/email/password/MFA; expect Home, Records,
   Devices, Tasks and More with NO top ITSM/RMM switcher.
2. Home: chart and stat tiles, recent tickets, offline device actions.
3. Global search: search a ticket, RMM device, person, CMDB item, project,
   task and knowledge article; open results in native screens.
4. Ticket -> Find device and open RMM tools -> Lenovo -> start a remote
   session. Check full-resolution video, automatic iPhone keyboard on Windows
   text focus, file tools, input and safe session close.
5. CMDB with linked RMM device: open native device using deep link; confirm
   unlicensed/restricted accounts cannot access it.
6. More -> Navigation focus: Combined / Service Desk / Remote Monitoring.
   Verify five bottom tabs adapt; no cross-module permission bypass.
7. ITSM-only: no RMM tabs/search; RMM-only: no ITSM tabs/search.
8. Restricted staff account and requester: enforce server permissions. Do
   not show either staff workspace to requester.
9. Portrait, landscape, large dynamic type, dark/light mode and safe areas.
10. Sign out, change tenant and check no old tenant records are displayed.

## Known remaining enhancements

- Record/device relational mapping needs explicit linked device IDs from the
  ITSM API; otherwise manual device selection is intentional.
- Search uses data returned by existing permission-filtered API requests, not
  an unbounded server-side search beyond their current result limits.
- APNs push, passkeys, true offline caching, verified attachments and advanced
  ITSM workflow parity remain follow-up work.

## Recovery / project continuation

- Working unified v0.1.0 Actions run: 43386388903.
- Working standalone ITSM v0.3.0 Actions run: 43386385591.
- Working standalone RMM v0.5.16 Actions run: 43303475212.
- Lenovo Windows Agent v1.0.506, backend, TURN and VPS left unchanged.
- If runtime navigation fails, revert the combined-app branch only. Do not
  modify codec, RTP, ICE, TURN or Agent to correct iPhone navigation.
