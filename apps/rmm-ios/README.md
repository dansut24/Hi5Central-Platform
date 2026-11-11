# Hi5Central RMM iOS v0.5.9 — authenticated TURN fallback

Derived from native iOS v0.5.8, preserving the successful native v0.5.4 video negotiation and the manual iPhone keyboard.

A live test on 11 November 2026 generated 19 local ICE candidates but received only one remote candidate, with no relay candidates and no media path. A direct test of the original IONOS VPS TURN server passed allocation, permission, and relayed packet delivery.

Native iOS previously replaced the launch URL's ICE configuration with the subsequent WebSocket configuration, potentially losing TURN options. This build merges both trusted, session-scoped ICE sources, with signalling-first precedence, and accepts string or object remote ICE candidate messages matching the web viewer.

Connection details now includes the count of authenticated TURN servers available from the combined configuration and from the signalling message. Credentials, ICE addresses and SDP remain private. No VPS, server, Agent or codec changes were made.

Test: install the native-viewer-only IPA with Sideloadly, start a new session on the Lenovo, check authenticated TURN availability and ICE connection. If a relay candidate appears and video starts, test Notepad typing using the manual iOS keyboard. Automatic keyboard activation remains separate.

---

# Hi5Central RMM iOS v0.5.8 — restore confirmed working native ICE path

This recovery build is deliberately based on **v0.5.4 commit f3dff6d**, which followed the real-device working v0.5.2 native WebRTC confirmation on 2026-11-11 at 12:28 UTC, plus v0.5.4 touch fixes at 12:54 UTC.

It retains the v0.5.6 **manual iPhone keyboard** without the automatic Win32 focus detector.

**Native media:** the complete v0.5.4 offer/answer sequence, ICE handling, transceiver selection, WebSocket session and timeouts remain unchanged. In particular, the unverified receive-only transceiver, video-only SDP constraints, main-queue negotiation rewrite, and ping changes of v0.5.7 have been excluded.

**Read-only telemetry:** Connection details now displays number of local and remote ICE candidates and TURN relay candidate counts; diagnostic messages show SDP accepted, answer sent, gathering, ICE connected/failed, and video-track received. No addresses, credentials or SDP bodies are displayed.

**Environment:** keep working Lenovo Agent v1.0.318 on original IONOS VPS; do not rebuild Agent, change TURN, or switch servers.

**Live verification:** Install fresh IPA, open new remote session using tenant newtest; confirm iOS stream reaches "ICE connected" and visible video; in Connection details, relay and candidate counts reveal missing ICE paths if it fails. After video succeeds, open Notepad, tap keyboard icon, type directly using iOS keyboard; check Backspace/Return. Automatic keyboard-on-focus must be added only after this passes.

---

# Hi5Central RMM iOS v0.5.6 — video-first recovery with direct native keyboard

This release branches from the last pre-auto-keyboard v0.5.4 source at commit `f3dff6d` and retains native touch, zoom/pan, WebRTC, chat and file controls.

- **Video first:** automatic Windows editable-focus detection, focus messages and helper processes are not required for iOS connection or decoding.
- **Manual native keyboard:** after video connects, tap the keyboard icon. A real iOS keyboard opens immediately. Characters stream directly as `text_input`; Backspace, Return, Tab, Escape and arrows send paired `key_down`/`key_up` events.
- **No buffering:** entered characters aren't held as a local message or stored in logs. Autocorrect and auto-capitalisation are disabled.
- **Future auto-open:** remote Notepad/edit-field detection will be reintroduced only after this baseline is confirmed on the real iPhone, guarded so it can never block the signalling, ICE or video path.
- **Deployment:** iOS unsigned IPA only, no Windows Agent rebuild or server modification. Keep Lenovo v1.0.504 and VP8 unchanged.

## Live test
1. Install v0.5.6 on the iPhone; start a **new** session to Lenovo.
2. Verify visible video and secure-to-normal-desktop transition **before opening the keyboard**.
3. Tap Notepad's editing area on the remote desktop. Press the keyboard icon; type directly, then test Backspace and Return.
4. Hide the keyboard and confirm video and remote touch remain connected.
5. Report connection diagnostics and any exceptions; do not enable automatic focus probing until stream and manual input both pass.

---

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
