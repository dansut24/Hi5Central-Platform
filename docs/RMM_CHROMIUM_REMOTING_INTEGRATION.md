# Chromium Remoting integration — technical baseline (4 November 2026)

**Status:** source inspected, upstream WebClient built on Hi5Central's existing VPS,
and an *unexposed* QuickDesk-compatible signal broker implemented and tested.
This is **not** a live Chromium remote desktop session, an alternative production
endpoint, a replacement Windows service, or an assertion of better performance.

## Pinned upstream and build evidence

- QuickDesk `barry-ran/QuickDesk`: `f6651f0392f2d8d4ffda90461abf05dffdb4708e`
  (MIT main project; separate remoting component uses Chromium BSD-style license).
- Remoting fork `barry-ran/quickdesk-remoting`: branch
  `140.0.7339.249`, current inspected tip `0a502e844e10081c11c0a81eb40171466de252e4`.
- Published Windows native assets: `quickdesk-remoting` release
  `v1.0.3/Windows-x64.zip`, SHA-256
  `027bf20f5d2f770f3149722e70b85f4de8a4e6f09c2be68dc6b9d8a478dd8a55`.
  The ZIP contains `quickdesk_host.exe` (~534 KB),
  `quickdesk_core.dll` (~36.5 MB), `quickdesk_client.exe`,
  and `icudtl.dat`. **Do not execute/install until the auth binding is complete.**
- Vite-built QuickDesk WebClient succeeded on the VPS with Node 22:
  `npm install --ignore-scripts`; `npm run build`; ~1.1 MB static `dist/`.
  `WebClient/remote.html` and `WebClient/js/**` are separate static modules,
  not part of the compiled Vue SPA.
- Source entrypoints: `WebClient/js/protocol/session.js`,
  `WebClient/js/signaling/websocket-transport.js`,
  `WebClient/js/signaling/jingle-builder.js`,
  `WebClient/js/protocol/datachannel-handler.js`,
  `QuickDesk/src/manager/HostManager.cpp` and
  `QuickDesk/src/manager/ProcessManager.cpp`.

## Chromium native host vs our Agent

QuickDesk's Chromium host is a separate process/service; on Windows QuickDesk
normally manages `QuickDeskHost` via session-specific named pipes:
`quickdesk_host_<session>_in` and `_out`, or launches it as a child
using `--config-dir` and native messaging over stdin/stdout.

Chromium host message protocol v3 supports `hello`, `connect` (signaling
server URL, runtime credentials, ICE configuration), `disconnect`,
`authorizationResponse`, `kickClient`, and
`refreshAccessCode`. Host/Viewer signaling requires Jingle XML and
SPAKE2 proofs, not Hi5Central's current JSON `webrtc_offer` and
`webrtc_answer`. **Do not map the default QuickDesk 9-digit ID/access
code directly to an unauthorised tenant/device.**

Chromium's capture scheduler prevents an overlapping capture and bounds
backlogged frames (legacy scheduler: at most two frames awaiting encoding
and four unacknowledged frames). Current Hi5Central/HEVC measurements
showed zero packet loss but up to ~642 ms viewer playout buffer, so a
bounded sender/receiver pipeline is a concrete area to compare, not proof
that replacing the engine will improve performance.

## Hi5Central integration contract

1. Preserve the existing multi-tenant RMM session creation, technician
   permission checks, MFA policy, audit trail, session revocation and device
   identity. Add a per-session opt-in `chromium` engine only after the
   authenticated Windows Agent confirms support; legacy WebRTC stays default.
2. Generate separate ephemeral, cryptographically random host aliases,
   SPAKE2 shared secret and single-use signaling tickets *after* existing
   RMM session validation. Never place secrets in query parameters, logs,
   localStorage, or unauthenticated public assets.
3. Deliver host configuration through the **existing authenticated
   Agent WebSocket**, and manage its native child or Windows service
   through the Agent lifecycle, including session-end tear-down,
   Ctrl+Alt+Del/UAC desktop switches and clean uninstall.
4. The browser uses a Hi5Central-branded QuickDesk-compatible session
   adapter, translating Jingle and protobuf data-channel controls.
   Host and Viewer connect through our **tenant-scoped** signaling path.
   Maintain the existing coturn relay and single VPS. Do not require
   QuickDesk's standalone user database, Redis, or a public access-code page.
5. `rmmChromiumSignalBridge.js` supplies the **in-memory protocol core**
   only: 30s one-use ticket, exact tenant/session/device/role/client binding,
   payload bounds, replay protection, rate limiting, session expiry and
   revoke/detach semantics. The API controller must implement real H5C
   authorization before calling `issueTicket`; route is deliberately
   **not attached** until a host adapter exists.
6. Use the existing Viewer shell and record-detail device links. The
   QuickDesk upstream WebClient is **not safe to copy as-is**: review CSP,
   third-party browser importmaps, auth storage, code licenses,
   clipboard/input permissions and failure handling before packaging.
7. Keep VP8, VP9, AV1 and H.264 compatibility. QuickDesk's documented
   codec set omits H.265: retain our proven H.265 path, or explicitly add
   and verify Chromium HEVC support before claiming full five-codec parity.

## Completion gates

- Real Windows host boots without replacing/stopping Hi5CentralAgent.
- End-to-end protocol v3 `hello/connect/auth_ok`, Jingle+SPAKE2 and
  authenticated Browser Video track succeeds on the same Dell.
- Native 1080p video, real decoded/rendered 30 FPS target, intelligible
  text, low input round-trip, low playout buffer and low packet loss.
- Compare identical session tasks against Hi5Central's corrected
  opt-in native HEVC baseline (Agent PR #105), using the same RMM Viewer
  and same network.
- Validate CAD/UAC/Winlogon transitions, multi-display, unattended sign-in,
  clipboard, input, mobile Safari/Chrome, reconnection and exit.
- Verify token replay/cross-tenant tests, transport failures, unattended
  startup safety, packaging notices, service removal and rollback.
- Disable Chromium path automatically on any failure; **no merge/rollout
  from this protocol-only draft**.

## Dell Windows host artifact preflight completed

- Host binaries downloaded from the pinned `v1.0.3` GitHub release
  **directly on Dell `DESKTOP-2JHH2ON`** via the existing authenticated
  Hi5Central Agent command channel, verified SHA-256, and extracted into
  `C:\\ProgramData\\Hi5Central\\Agent\\Chromium\\quickdesk-remoting-v1.0.3\\bin`.
  No additional Windows service was installed.
- Binary hashes: `quickdesk_host.exe`
  `01de5e356163896a0df967f73011e5315b2b17530d550017ee9f16799e7b20bb`;
  `quickdesk_core.dll`
  `b5137bc27a2d3e505deea133382b8a6eb2587159b9c787c00f7e7f1daa24c127`.
  Both binaries are unsigned; verify pinned release provenance and maintain
  source/version checks before shipping.
- Launched the host **only as a short-lived local child**, sending the
  Chromium native-messaging length-prefixed
  `{"type":"hello","protocol_version":3}` frame over stdin.
  Actual host returned `helloResponse`, protocol v3 (196-byte JSON payload)
  and 2 supported features. The child was killed/exited cleanly,
  with **zero lingering host processes, no QuickDeskHost service and no
  signaling endpoint or remote credentials configured**.
- Tested the **actual** QuickDesk `WebSocketTransport` JS module with
  `RmmChromiumSignalBridge` via an in-process WebSocket mock. Real upstream
  first-frame `auth/auth_ok`, Jingle client-to-host envelope and
  host-to-client Jingle response all passed. This is a local protocol
  compatibility test, not a live video session.
- Ten bridge protocol/security cases pass, including replay, cross-tenant
  and cross-client isolation, token expiry, and revocation. Other RMM
  codec health tests pass. Legacy Agent is still **1.0.305 connected**.

## Next actionable implementation slice

Add a scoped Windows host manager with a native messaging bridge, and
a server controller that issues host/client tickets by consulting
`rmm_remote_sessions`, authenticated device sockets and the existing
viewer token hash. Wire `revokeSession` into existing termination and
supersession. Only then expose an authenticated, feature-gated WebSocket
endpoint and Chromium Viewer option.

Tracking: Hi5Central Platform issue #170; Agent cache PR #104;
opt-in HEVC native-resolution PR #105.

## Guarded Dell adapter tests and rollback — 4 November 2026

**Native-host wire incompatibility confirmed:** the pinned Chromium/QuickDesk host still connects to /signal/{deviceId}?access_code=... and sends raw Jingle XML, whereas the newer QuickDesk browser and Hi5Central bridge use /v1/realtime/signal, first-frame JSON auth, and JSON-enveloped Jingle. Browser-side compatibility alone could not start video.

Added a temporary Hi5Central-only loopback adapter (rmmChromiumLoopbackHostBridge.js), listening solely on 127.0.0.1. The native host can keep its old local signaling path; the adapter validates its ephemeral access code, connects outbound to authenticated Hi5Central WSS using a single-use host ticket, and forwards Jingle XML in either direction. It enforces origin and session-scoped client routing, bounded payloads, encrypted WSS for the server leg, and expiry. This adapter is **test-only**, not a customer-facing or generally deployable Node dependency.

**Transport tests passed:** actual local TLS/WSS host-format raw XML -> authenticated Hi5Central broker -> browser-format JSON Jingle, including the return path. This is not a real Chromium video or SPAKE2 test.

**Windows smoke passed:** the staged adapter loaded on Dell DESKTOP-2JHH2ON with Node.js 26, bound to 127.0.0.1, and closed without leaks. The initial ESM bundling failed due to dynamic require of the built-in events module; rebuilding as CommonJS corrected the failure. The verified final bundle is hi5-chromium-loopback-bridge-bundle.cjs, SHA-256 f320d41d15ad4381acc8d666bec4d99a08e15218063b5fa018f81c4999bb864b. No Chromium remote session or persistent service started.

**Rollback armed:** the Dell retains its original Agent 1.0.305 installer (SHA-256 81c7e14a7c103e4cf70f31c3fb7c7b0ef9252c3bdc79b88b04ec9ec22ba3100f), original service settings, and SYSTEM Scheduled Task Hi5CentralChromiumVideoAutoRestore-20261104, due 2026-11-04 23:05:48 UTC. The task stops only experiment-tagged Chromium and Node helper processes, not the Hi5Central Agent. The VPS container baseline and task scripts are stored at /opt/hi5central/runtime/rmm/shared/chromium-live-ab-20261104. Production RMM API, Viewer and TURN were not restarted or changed.

**Open blocker:** a proposed native Chromium host connect probe was blocked before execution; it was not bypassed, so no video performance improvement has been demonstrated. Next work requires a safe authenticated host connect lifecycle and actual QuickDesk/Chromium SPAKE2 + WebRTC video negotiation under the Hi5Central Viewer, followed by 1080p image/latency/FPS comparison with legacy streaming and confirmed rollback.

## Browser Viewer grant integration and verified rollback — 4 November 2026

The original QuickDesk WebClient Session class generates a random `webclient_` identity internally. Hi5Central's new Chromium signaling ticket is bound to the *server-issued* client ID; the two would otherwise differ and cause authentication failures. The pinned-source patch `third_party/quickdesk/patches/0001-h5c-bound-browser-client-id.patch` adds a validated `options.clientId` to the Session and reuses it in the SPAKE2 JID and WebSocket signaling identity. The patch applied cleanly to pinned QuickDesk commit f6651f0392f2d8d4ffda90461abf05dffdb4708e; offline test against the actual patched upstream Session passed, including identity and JID equality.

`apps/rmm/public/rmm-viewer/chromiumSessionAdapter.js` creates Chromium Session instances *only* from the already authenticated Hi5Central Viewer `chromium_access_result`. It validates short-lived grant, WSS signaling base, client ID, host alias and allowed codecs; it passes the SPAKE2 secret in memory rather than URL parameters or browser storage; it disconnects cleanly on failure. Its five tests and the broader Chromium/RMM suites passed (39 tests total); API runtime build was successful. The Viewer module is not yet wired into production and no live Chromium video was sent.

Important upstream dependency: QuickDesk WebClient's remote.html importmap loads `@noble/curves` and `@noble/hashes` from esm.sh. Hi5Central must bundle locally hosted pinned dependencies rather than depending on a remote CDN. The offline Session test used the pinned 1.8.1 and 1.7.1 versions locally, not production CDN resources. The upstream WebSocket transport itself appends `/v1/realtime/signal`; supply a WSS origin *without* that path to avoid a duplicate route.

**Rollback was functionally tested on the Dell:** at 2026-11-04 23:02:25 UTC, `Hi5CentralChromiumVideoAutoRestore-20261104` was manually triggered with no active Viewer stream. The Scheduled Task returned exit/result `0` and logged `ROLLBACK_SIDEcar_COMPLETE version=1.0.305 killed=0` at 23:02:27 UTC. Post-test observations: `Hi5CentralAgent` Running, Agent 1.0.305, `HI5_CODEC=auto`, zero `quickdesk_host.exe` and zero experimental Node sidecar processes. The original 23:05:48 UTC trigger remains registered and can rerun idempotently. No Agent reinstall or production API, Viewer or TURN restart was required.

**Blocker for true performance test:** the proposed native Chromium-host `connect` execution was blocked before execution, and was not bypassed. With no authenticated native host+WebRTC media session, this milestone cannot report 1080p, delivered FPS, text quality or latency. Do not merge/deploy by default or advertise a faster Viewer until an authorised host-to-browser video stream has been measured against the legacy stream.

## Chromium media negotiation and measurable trial — 4 November 2026

**Important additional native-host blocker:** pinned `quickdesk-remoting` branch `140.0.7339.249` (`0a502e844e10081c11c0a81eb40171466de252e4`) has two outgoing signaling paths. `QuickDeskSignalStrategy::SendStanza` emits Chromium Jingle XML, but `SendMessage` converts authenticated Jingle XML into generic WebRTC JSON via `WebRtcToJingleConverter::ConvertFromJingle`. The upstream browser WebClient `_handleJsonMessage` does **not** turn generic SDP JSON messages into RTC descriptions; it only emits a diagnostic event and processes signaling errors. This is a protocol incompatibility risk that can leave signaling apparently connected with no authenticated video.

Patch `third_party/quickdesk/patches/0002-native-host-preserve-authenticated-jingle.patch` changes the native host to preserve original Jingle XML (including SPAKE2 and SDP), validates the host stanza and originating JID, and logs only payload lengths, not XML contents. It was applied and inspected against the exact pinned fork source on VPS. **It has NOT been compiled into `quickdesk_core.dll` or installed on Dell.** The existing v1.0.3 prebuilt Windows host remains unpatched and should not be used as evidence of Chromium browser compatibility.

**Self-hosted WebClient build:** `apps/rmm/scripts/buildChromiumBrowserPilot.mjs` reproduces a locally bundled static Session module from pinned QuickDesk commit `f6651f0392f2d8d4ffda90461abf05dffdb4708e`, applies our authorised-client-ID patch and embeds pinned `@noble/curves@1.8.1`, `@noble/hashes@1.7.1`. Verified output approximately 59 KB, with SHA manifest and separate MIT licence notices. It does not load `esm.sh` or QuickDesk's full application UI at runtime and does not deploy to production by itself.

**Video-only evaluation with safe fallback:** `chromiumVideoTrial.js` waits for a genuine browser `requestVideoFrameCallback` at 1920x1080 before permitting optional trial promotion. A 720p stream, absent frame, failed WebRTC connection or expired timeout restores existing Hi5Central video without changing the Agent. After promotion the separate staging video stops decoding, to avoid duplicating decoder work and corrupting performance measurements. `chromiumMediaPerformanceProbe.js` samples RTCPeerConnection `getStats` and actual presented frames, including decoded/rendered FPS, width/height, bitrate, jitter-buffer delay, frame drops and RTT. It does not record screen or input content. Comparative acceptance requires at least five active-motion samples per engine, real native 1080p, at least 20% rendered-FPS uplift and no meaningful jitter/RTT regression; idle 0 FPS is not classified as a freeze.

**Verification:** 56 Chromium/Viewer/RMM regression tests green, production API bundle builds, exact native patch applies to pinned upstream source. Neither the browser experimental video trial nor corrected native host is enabled or deployed. There has **still been no actual Chromium WebRTC video on the Dell**, so there are no valid Chromium FPS, visual quality or latency results to report.

**Rollback confirmed live:** the Dell SYSTEM scheduled rollback task executed both manually at 23:02 UTC and automatically at 23:05:48 UTC, both result 0. Agent v1.0.305 remains Running/Connected with `HI5_CODEC=auto`; no Chromium host/sidecar process remains and production RMM API, Viewer and TURN are unchanged. The next real gate requires rebuilding the patched native host in a reproducible Chromium toolchain and completing an authorised Windows host-to-browser Jingle/SPAKE2 and WebRTC session, without bypassing the previously blocked host-launch safety control.

## Windows native host build readiness, 5 November 2026

The native Jingle source correction remains **source-level only**. It has not been compiled into the Windows `quickdesk_host.exe` or Chromium core DLL, and no Chromium video session has been attempted using corrected binaries. Keep Chromium experiments disabled and Agent 1.0.305 as the working stream.

Added `scripts/build-chromium-native-host-windows.ps1` and `.github/workflows/chromium-native-host-windows.yml`. The Windows workflow has two independent jobs: (1) Windows-2025 validates the pinned fork source SHA and that our audited Jingle preservation patch applies, plus the actual build PowerShell script syntax; (2) an explicitly requested full build on a *dedicated* self-hosted Windows runner labelled `chromium-builder`, with a complete pre-synced Chromium tree, GN/depot_tools/autoninja, and Visual Studio with C++ tools. Job 2 is never run for pull requests or on the Dell/VPS, and no built binary is installed automatically. Successful builds would upload hashed EXE/DLL/ICU outputs for review, preserving third-party notices.

**Verified Windows source-contract CI:** run `41945529089`, job `126976656686`, conclusion `success` on 2026-11-05. The initial run failed due to Windows checkout line endings and was corrected using `.gitattributes` and explicit LF patch normalisation. The final Windows job validated the exact source commit `0a502e844e10081c11c0a81eb40171466de252e4`, original SHA `b4438b5c7b9cddb47feefadac880fdf0005e95f4d66eb3e358f4e9f6d032cdbc`, patch semantics, and build-script parser. The CI report records **16 GB RAM and 30.6 GB free** on the Windows-2025 runner; this is insufficient for full Chromium source/build. The full-build job was correctly skipped, not passed.

**Dell read-only preflight:** 7.7 GB RAM, 69.6 GB free on C:, Visual Studio installed, but no GN, Ninja, depot_tools or synced Chromium source. Current Agent remains 1.0.305 Connected, no active test Viewer session. The single production Ubuntu VPS has 7.7 GB RAM and must not be used for an intensive Chromium/Windows native compile.

**Needed to proceed to video:** dedicate a Windows x64 build workstation/runner with roughly 32+ GB RAM, 200+ GB free for initial Chromium checkout and build, VS C++ tools and Chromium depot_tools. Pre-sync the exact pinned source into `C:\h5c-chromium\src`, register GitHub self-hosted runner label `chromium-builder`, and invoke the existing workflow's full-build input. Verify the generated DLL/EXE and pinned hashes before any A/B session on Dell. Only actual 1920x1080 *presented* frames and measured FPS/latency justify enabling the experimental Viewer. The existing timed Chromium pilot cleanup task had executed successfully twice; continue to use session-bound short-lived rollback for any future host binary.
