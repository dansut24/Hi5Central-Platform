# Hi5Central RMM iOS v0.4 — Native UI upgrade

This branch carries the SwiftUI native RMM app, compiled by GitHub Actions on macOS and installed for testing through Sideloadly. The existing Hi5Central backend is unchanged.

## Native interface
- Splash, tenant-aware password login, MFA, main navigation, dashboard, Devices, Alerts, device details and Connect
- Patching dashboard, existing policy listings, Windows/Unix update and vulnerability summaries
- Software catalogue with search, source filter, pagination and package details
- Automation catalogue, recent jobs, published-automation execution on a selected online device with confirmation
- Recent activity and jobs reports
- Settings with persisted System, Light and Dark appearance, local notification tests, read-only tray-policy overview
- Profile, sign-out, and account information

## Remote viewer
- Native SwiftUI toolbar with SF Symbols (file transfer, chat, audio, monitor, Windows/start menu, Ctrl+Alt+Del, zoom, fit, precision, trackpad, clipboard, Backstage/Console and settings)
- Keyboard text is composed using the iPhone's native keyboard and sent through the existing remote text-entry function
- Connection status and a confirmation before secure attention/input block
- Existing authenticated WebRTC viewer/video remains in WKWebView, with its old web toolbars hidden **inside the app only**
- The screenshot-reported AV1 codec negotiation issue is deliberately out of scope for this build

## Important boundaries
- This release makes all main tab routes native, but **advanced workflows are not fully feature-parity**. The native patching and software views currently provide discovery/search/inspection rather than all deployment, policy-editing and approval operations.
- The previously working backend and website are not modified. Native automation run and remote session termination actions use existing endpoints/permissions.
- Passkeys are not yet implemented; push from the server needs properly signed APNs. Native local notification demonstration remains free.
- Dark/light modes use iOS appearance APIs and system-adaptive backgrounds. The actual remote video area is intentionally black.
- Viewer controls and keyboard text-entry must be checked on a real iPhone; GitHub's unsigned build verifies compilation, not live WebRTC behaviour.
- The Android native design parity work remains outstanding.

## Test
1. Open GitHub Actions > **RMM iOS unsigned IPA** for the latest successful branch build.
2. Download artifact **Hi5CentralRMM-iOS-unsigned**, extract the IPA on Windows.
3. Install with Sideloadly; free Apple ID signing usually requires renewal every seven days.
4. Check native Home, Devices, Alerts and all More tools without loading the website.
5. Settings > Appearance: select Light, Dark and System; confirm all main screens change immediately.
6. Open remote desktop; test native files/chat/audio/Windows/monitor/zoom/keyboard/clipboard buttons. Confirm CAD prompt and end session.
7. Open Software, search Hi5Central and WinGet sources; open a package. Open Patching, Automation, Reports and Connect.
8. Settings > Send local test notification: allow notifications, lock screen, and verify banner.

### Next implementation
Full native policy editing / patch/install approvals, native automation creation, full reporting filters, passkeys, signed server push notifications and Android parity.
