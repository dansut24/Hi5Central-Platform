# Hi5Central Mobile — v0.3.0 native technician command centre

Branch: feature/hi5central-ios-v030-command-centre

A separate combined iPhone application with bundle ID com.hi5central.mobile.
Standalone ITSM and RMM applications remain unchanged.

## What changed from combined v0.2.0

- One unified native navigation retained: Home / Records / Devices / Tasks / More
  for dual-module companies. Permission-limited and workspace-focus navigation
  still adapt to the server-authorised modules.
- Action-first Home: Quick actions for New ticket, Remote support, Approvals and
  Global search. Attention panel shows visible High/Critical records, pending
  Service Request approvals and offline agents, with deep links into native UI.
- Records workbench: All/Open/Mine filters, record-type filter, search, count
  display, create button, native ITSM record details and editor.
- Devices workbench: Online/Offline/Inventory filters, name/site/assignee search,
  Online-first sorting, device detail and a swipe-to-remote action on online agents.
- Activity inbox: ITSM in-app notifications plus RMM *connectivity* warnings,
  segmented filters for dual-module tenants, drill-downs and pull-to-refresh.
  RMM policy alert history and actual APNs push are not yet included.
- Universal header quick-actions menu with New ticket, Approvals, Find device
  and Search, visible only for modules enabled by the server's access policy.
- Existing global search, CMDB-to-RMM links, ITSM ticket remote-support picker,
  MFA login, light/dark mode and native five-tab UI are retained.

## Build / installation

Workflow: .github/workflows/hi5central-ios-unified-ipa.yml
Artifact: Hi5CentralMobile-iOS-v0.3.0-command-centre
IPA inside artifact: Hi5CentralMobile-iOS-unified-native.ipa

Sideloadly installs over combined v0.2.0 without replacing standalone apps.
A green GitHub build only proves successful Swift compilation and IPA packaging;
it does not prove live remote connectivity or iPhone UI behaviour.

## Real iPhone QA checklist

1. On a tenant with both products, confirm Home/Records/Devices/Tasks/More,
   correct full-screen layout, one native tab bar and no product switch at top.
2. Tap Home quick actions: New ticket opens correct editor; Remote support
   opens device selector; Approvals opens approval list; Search opens both
   product results.
3. Home attention rows open the correct ticket/device; count labels reflect
   only accessible records. Test tenant with zero data.
4. Records tab: All/Open/Mine and record-type filters, keyboard search, create
   Incident and open ticket details. Check existing permission checks.
5. Devices tab: Online/Offline/Inventory filters, sorting, device info, and
   swipe Remote on an online Lenovo endpoint.
6. Start native WebRTC session; confirm codec/resolution, auto iPhone keyboard,
   touch and mouse, Windows UAC/CAD transitions and safe close. No changes
   were made to the streaming engine or viewer.
7. Bell: segmented ITSM/RMM feed, mark ITSM notice read, open a linked ticket,
   and open an RMM offline device. Connectivity warning is not policy history.
8. Test ITSM-only and RMM-only tenant; hidden product modules MUST NOT appear
   in Home, Search, Activity, shortcuts, deep links or More.
9. Sign out and log in with another tenant, verify no previous company data,
   and test portrait/landscape, Dynamic Type, dark and light appearance.

## Next suggested releases

- v0.4: Native ticket activity composer redesign, richer record resolution and
  full workflow parity, reliable attachment upload/download and Service Request
  catalogue/fulfilment.
- v0.5: Notification deep links, real APNs push through a managed backend
  device-token flow (requires Apple capability support), passkeys/Face ID
  enrolment and secure per-tenant session lifecycle.
- Later: native People/CMDB/Projects editing, Calendar and Knowledge features,
  offline-safe drafts, more advanced RMM alerts and an intentional, supported
  link between ITSM configuration items and RMM devices.

## Handover / recovery

Previous combined v0.2.0 green Actions run: 43412656456
Previous combined v0.2.0 final documentation run: 43412947756
Original unified v0.1.0: 43386388903
Standalone ITSM v0.3.0: 43386385591
Standalone RMM v0.5.16: 43303475212

Do not modify WebRTC codec, RTP, ICE, TURN, Windows Agent, server deploy,
standalone app sources or Caddy to fix combined iPhone navigation.
