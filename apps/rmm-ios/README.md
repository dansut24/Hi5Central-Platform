# Hi5Central RMM iOS v0.5.14 — in-app UK Windows laptop keyboard

Builds directly on the user-confirmed native WebRTC and typing baseline v0.5.13. No Agent, codec, ICE, TURN, viewer signalling or VPS changes.

**New default keyboard:** Full-width UK ISO laptop QWERTY, function keys F1–F12, number row, punctuation, tall Enter, Backspace, Tab, Caps Lock, two Shifts, Ctrl, Fn, Windows, Alt/AltGr, Menu, Space, navigation arrows. Fits iPhone width without horizontal scrolling; smaller key rows in landscape. The **Num pad** control switches to a separate 4-column keypad with tall +/Enter keys and Num Lock mapping; **Laptop** switches back.

**Shift keycaps:** Key glyphs update immediately to match the actual character that will be injected, including `/` → `?`, `2` → `"`, `3` → `£`, `'` → `@` and `\` → `|`. Caps Lock affects alphabetic keys only; Shift is one-shot, while Caps Lock persists. Each pressed key has a raised iPhone-style preview and haptic feedback. The browser/Windows codec policy is untouched.

**Remote transmission:** Unmodified text is sent via the proven Unicode `text_input` path. Special keys and modifier combinations use balanced key_down/key_up physical DomCodes; nonprintable keys are labelled `Unidentified` to avoid the Windows Agent accidentally pasting their names. The Windows service already accepts the relevant DomCodes. Buttons hold no remote text locally.

**Fallback:** The toolbar's `iOS` button returns to the v0.5.13 native system keyboard and its Windows utility strip. The native keyboard button remains fixed outside the zoomed desktop. Windows Search remains a deliberate Windows+S shortcut; automatic text-field focus for arbitrary Windows applications requires a separate, event-based Agent capability in a future release.

**Real-device test:** Install unsigned `Hi5CentralRMM-iOS-native-viewer-only` IPA with Sideloadly. Open a new Lenovo remote session. Confirm native VP9 video and touch still work. Focus Notepad and press `/`, Shift then `/` (must type `?`), Shift+`2` (must type `"`), Shift+`3` (`£`), Caps then letters. Test Win+R, Ctrl+A, Backspace, Enter, Fn/F keys, Num pad and Num Lock; test key press popups and portrait/landscape. If any key fails, use `iOS` fallback; v0.5.13 remains the known-good recovery build.

---

# Hi5Central RMM iOS v0.5.13 — native Windows typing

This release builds directly on **v0.5.12**, the first restored working native WebRTC streaming build. It **does not modify** the codec factories, SDP signalling, ICE handling, remote-session routing, Windows Agent v1.0.318 or original IONOS VPS.

**Native iOS system keyboard:** Keep the normal iPhone keyboard instead of a fully custom keyboard to preserve native layouts and accessibility. Text is sent to the existing remote `text_input` path, not retained locally. Backspace and Return use remote key events.

**Windows key strip:** Win, Esc, Tab, Shift+Tab, Backspace, Delete, arrows, Home, End, Ctrl+A/C/V/X, and Alt+Tab in a horizontally scrollable bar directly above the iPhone keyboard. Key chords send balanced physical down/up events with modifier flags (prevent the Windows Agent treating a chord key as text).

**Visible keyboard controls:** Large 46-point keyboard toggle in the fixed iOS header, plus a second fixed Keyboard button in the bottom toolbar; both work whenever the native video is present, even if ICE transiently reports disconnected. The remote canvas is the only zoomed view.

**Windows Search:** A dedicated fixed **Search** toolbar button sends Windows+S and opens the iPhone keyboard; this works at every zoom and doesn't depend on taskbar placement. A conservative desktop-tap hot-zone also opens the iPhone keyboard when tapping common Windows 10/11 taskbar Search positions. This heuristic is limited to taskbar clicks; automatic detection of arbitrary application text fields will require Agent-originated Windows focus events later. Remote focus telemetry is intentionally NOT restored in this build because it previously destabilised streaming.

**Test on iPhone:** Open remote Lenovo session; zoom 2–4x, press Keyboard in header and then bottom toolbar and verify both can summon iOS keyboard. Tap **Search** and type text in Windows Search; test Notepad by tapping editor, then tapping Keyboard, typing and pressing Backspace, Return, Tab and Ctrl+A. Verify native video persists over secure desktop transition.

---

# Hi5Central RMM iOS v0.5.12 — VP9/VP8 native codec negotiation fix

**Evidence (11 November 2026):** During the failed native v0.5.11 session at 19:31 UTC, Lenovo Agent v1.0.318 selected `vp9_sw` in automatic mode and offered VP9 RTP payload type 98. The Agent accepted the iPhone's SDP answer (784 bytes) and accepted ~25 ICE candidates. The ICE peer never connected. Successful browser SDP answers on this Agent were 854–969 bytes.

**Root cause hypothesis:** iOS native `RTCPeerConnectionFactory()` has H.264-only default video codec factories, per the official WebRTC Apple API contract. The auto-selected VP9 offer therefore cannot be answered with active video, explaining ICE stuck at checking with no decoded frames.

**Fix:** Replace the default factory with `RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())`, initialising WebRTC SSL first. This enables VP8/VP9 software codec support on iOS without overriding the Agent's hardware/software codec policy.

**Safe diagnostics:** The native Connection details will show the video codecs advertised by the Agent offer and whether the generated SDP answer's video m-line is accepted or rejected. No SDP, ICE IP addresses, session tokens or credentials are logged.

The existing RMM remote-session routing to `{tenant}-rmm.hi5central.com`, native touch controls, authenticated TURN, and manual native iOS keyboard remain in place. No Windows Agent, VPS, TURN, ITSM, or shared API changes.

**Test:** Install the native-viewer-only unsigned IPA with Sideloadly, start a fresh session from tenant `newtest` to Lenovo. Expect `Remote video offer received: VP9`, `Native video m-line: accepted`, then ICE Connected and video frames. If successful, open Windows Notepad and use the iPhone keyboard button to type, Backspace and Enter. Leave automatic keyboard focus detection disabled until direct typing is verified.

---

# Hi5Central RMM iOS v0.5.11 — correct remote-session API routing

**Confirmed root cause (11 November 2026):** RMMClient.swift hardcoded all API requests to https://api.hi5central.com, the shared `api-control` container. That production container has no TURN_SHARED_SECRET_FILE or TURN secret mounted. The native viewer was therefore being supplied two STUN servers, no TURN entry, and a WebSocket endpoint from the wrong API. The dedicated RMM API behind https://{tenant}-rmm.hi5central.com has the correct TURN secret and has passed authenticated relay allocation and relayed packet checks.

**Fix:** Keep login, MFA and generic platform actions on the existing api.hi5central.com host, but send POST /api/v1/rmm/remote-sessions exclusively to https://{tenant}-rmm.hi5central.com. The tenant slug is already validated against a strict hostname-safe pattern. The authenticated session uses the existing scoped Hi5Central cookies, and the dedicated RMM API returns the correct browserUrl, RMM signalling WSS URL, and time-limited ICE/TURN credentials. The native app continues to reuse the v0.5.4 WebRTC negotiation path plus the v0.5.10 ICE/TURN diagnostics and the native iPhone keyboard.

No Windows Agent, TURN, Caddy, release pipeline, or ITSM API change is required. The original IONOS VPS remains the only deployment target.

**Next iPhone test:** install unsigned native-viewer-only IPA via Sideloadly; sign in normally, select the newtest tenant and open a fresh Lenovo session. Connection details should now show authenticated TURN greater than zero, ICE connected, video frames and responsive touch. Then open Notepad and use the iPhone keyboard button to type and test Backspace and Enter. If the session API responds 401, investigate shared-domain cookie/auth configuration between the platform and dedicated RMM API without falling back to the API instance missing TURN.

---

# Hi5Central iOS v0.5.10 — raw ICE contract and signed TURN recovery

On 11 November 2026, iPhone v0.5.9 reported two parsed STUN servers and no TURN credentials, preventing native ICE connectivity. The original IONOS VPS's running backend binary appears designed to issue a third TURN entry and the TURN allocation/relay self-test succeeded, so it's important to distinguish a missing backend entry from a client-side decoding error.

This build logs **counts only** of ICE rows, TURN rows, and authenticated TURN records in the WebSocket's raw session_config payload, and the launch URL fragment's raw and parsed ICE rows. No token, credential, raw URL, network address or SDP is displayed.

Where the authenticated session-creation JSON response contains explicit connection.iceServers with TURN credentials, the app places those short-lived credentials into the in-memory browser launch fragment, without saving or logging them. The native engine still uses the established v0.5.4 offer/answer logic and merges both launch and WebSocket ICE configurations.

Test native v0.5.10: after a fresh session, inspect "Launch ICE" and "Signalled raw ICE" counters. If raw TURN >0 and parsed TURN =0, the Swift decoder needs repair. If both raw TURN=0, the server is not issuing credentials and requires a backend-side fix. Keep the browser viewer and Lenovo Agent v1.0.318 with auto codec unchanged.

---

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
