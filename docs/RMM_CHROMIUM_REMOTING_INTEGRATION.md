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
