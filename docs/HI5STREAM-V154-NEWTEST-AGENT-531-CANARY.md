# Hi5Stream v0.15.4 → Original RMM Agent 1.0.531 Canary

**18 November 2026** — isolated Newtest Lenovo test, not a fleet rollout.

This branch is based on the existing qualified 1.0.530 GDI/VP8 agent
lineage, not the unrelated Rust/Go lab and not a replacement WebRTC stack.

## Build and activation gates

1. Existing native agent source unchanged when
   `HI5_ENABLE_WGC154_CANARY=OFF` (CMake option, default).
2. Opt-in Windows build (agent v1.0.531) includes the separately
   compiled proprietary WGC callback, libyuv and portable absolute
   FPS scheduler, but **runtime defaults OFF**.
3. An administrator must explicitly set the **agent SERVICE** launch
   environment variable `HI5_STREAM_V154_WGC_CANARY=1`.
   The normal interactive streamer ignores any user environment override.
4. The service itself checks hostname `DESKTOP-Q9LTF1M`, monitor 0,
   not backstage, FPS 15/30/45/60, and only passes
   `--wgc154-canary` to the authenticated NORMAL streamer helper.
   The secure desktop helper NEVER receives that flag.
5. The helper independently repeats the allowlist, secure desktop,
   secure-helper, monitor and FPS eligibility checks. When normal
   capture starts, WGC gets real Windows monitor frames.
6. New WGC 0.15.4 latest-only callback uses D3D11 GPU readback and
   libyuv BGRA→I420→1280×800. Absolute deadline pacing consumes
   the freshest frame *after* the requested FPS deadline.
7. The original shared-memory frame interface, authenticated WebRTC
   sender, ICE/TURN, VP8 libvpx, RTP, keyboard and mouse data
   channels are retained. A separate canary hint (stream mode 4)
   removes the old 20 FPS encoder profile cap only on eligible
   normal-desktop VP8 sessions. No codec bytes are mislabeled.
8. If WGC fails or secure desktop/monitor changes, it is stopped for
   the remainder of that session; original capture and UAC handoff
   continue. With the build flag OFF, all original code is compiled.
9. Current implementation is single host canary and not a
   tenant-wide rollout. The actual Newtest device identity must be
   rechecked by the operator in RMM before any install.

## Windows build

Public standard-runner GitHub Actions:
`.github/workflows/hi5stream-v154-newtest-agent-531.yml`

Branch: `test/hi5stream-v154-newtest-agent-20261118`.
A branch-scoped push triggers this TEST ONLY workflow. No mainline
push, auto-merge or production rollout.

Windows 2025 standard runner, MSVC, vcpkg (libvpx,
libdatachannel, libyuv, OpenSSL, nlohmann-json), WebView2 SDK and
Inno Setup. Vcpkg binary archive caching avoids repeated recompiles.
`Build-AgentInstaller.ps1 -EnableWgc154Canary -AgentVersion 1.0.531`
is explicit, with normal build behavior left unchanged.

Outputs:
- `Hi5CentralAgentSetup-1.0.531-WGC154-NEWTEST-TEST-ONLY.exe`
- `Hi5CentralAgentSetup-1.0.530-ROLLBACK.exe`
- manifest with SHA256, source SHA, device scope, default-off flags.

The original 1.0.530 rollback installer SHA256 is verified as
`2acfb0b12944c0ac2fd1c77fefc3ceaf99ec63fc3abd3f2cb01a43cdec0d2b4e`.
Public rollback download:
`https://downloads.hi5central.com/h5c-wgc154-newtest-rollback-20261118/Hi5CentralAgentSetup-1.0.530-ROLLBACK.exe`

Both are **unsigned diagnostic builds** unless a signing identity is
explicitly provided; do not represent them as production signed.

## Test and rollback

Before any install, confirm Newtest tenant, Lenovo hostname,
agent current version, WGC canary env state, normal-stream session,
and host health; backup agent install and verify rollback SHA.

Install via **already-proven, elevated scheduled task upgrade**
only on the explicit Lenovo. Do not use ordinary remote jobs that
will be disrupted by their own agent service restart.
The installer must never auto-run on every agent. Keep the existing
RMM portal and viewer for tests—no Go StreamLab pairing.

Start with flag OFF; confirm ordinary RMM remote control, UAC and
keyboard. Enable machine/service-scoped canary and restart
the service only during controlled test. Validate:
- VP8 1280×800, 30 FPS vs 60 FPS with motion;
- browser-reported FPS, dropped frames, p95 latency, freezes and
  device diagnostics;
- cursor, text input, keyboard, UAC/secure desktop, monitor switch;
- successful transition to fallback and reconnect.
If any regression: disable `HI5_STREAM_V154_WGC_CANARY`,
restart controlled service; if necessary run checksum-verified
1.0.530 installer with the proven scheduled-task rollback. No
automatic fleet rollout until complete and user approves.

## Public repository disclosure

This is proprietary Hi5Central-owned application source using
permissively licensed dependencies. Publishing to GitHub's PUBLIC
repository makes changed source code publicly readable, even
though copyright/contract rights remain. User expressly approved
public GitHub use to avoid consuming limited private action minutes.
