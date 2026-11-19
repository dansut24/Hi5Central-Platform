# Hi5Central 1.0.534: Hi5Stream v0.15.4 rebased to the qualified 1.0.530

## Confirmed fault and source mismatch (2026-11-19)

The user verified 1.0.530 live VP8 video on iPhone Safari. Versions 1.0.531 and 1.0.532 crashed in the legacy Windows capture constructor (0xC0000409). 1.0.533 corrected that constructor, captured frames through GDI, encoded/sent VP8 RTP packets, but the viewer remained at Connecting/Waiting for video.

The 1.0.531-1.0.533 pipeline checked out the platform's stale source lineage (d2d70d2) and compiled it directly. The actual successful 1.0.530 pipeline did not use this as its compiled source: it checked out 2a121cf0f03f89c866599ad2aba07eea9e2536c7, overlaid an exactly hashed 1.0.524 source archive, integrated pinned 1.0.528 readback/transport work and finally applied the 1.0.530 direct GDI/full-rate patches. It contained critical WebRTC RTCP recovery, H264 IDR, secure desktop and VP8 pipeline changes that were not carried into the 1.0.531 canary.

## Corrective implementation

The Windows workflow **hi5stream-530-qualified-534.yml** uses the ORIGINAL full qualified 1.0.530 workflow and its source pins, rather than the stale canary CMake baseline. After the 1.0.530 source has been reconstructed and validated by the original CI steps, `apply_hi5stream_534.py` adds **only**:

- An OFF-by-default CMake target for the v0.15.4 WGC+libyuv adapter, C++20 limited to the new .cpp; the original code keeps C++17.
- A strictly Newtest-Lenovo-only optional capture branch in `streamer_main.cpp`, with absolute 15/30/45/60 fps scheduling, latest-frame selection, metrics and fail-safe fallback.
- No changes to the resulting qualified 1.0.530 WebRTC sender, libvpx, signaling, Windows service, authentication, UAC, secure desktop, input launcher or legacy GDI/DXGI capture.

The WGC branch requires `HI5_STREAM_V154_WGC_CANARY=1`, and honors the existing independently gated `HI5_STREAM_FULL_RATE_CANARY` and `HI5_STREAM_FPS` 530 controls. Keep WGC off when testing 1.0.534 initial installation.

Build output is a **test-only unsigned** 1.0.534 Windows installer with checksum manifest and verified 1.0.530 rollback. It may be deployed only on `DESKTOP-Q9LTF1M` in Newtest, through the proven one-shot SYSTEM scheduled task after passing the full 530 test suite.

## Live acceptance gates

1. Confirm build, verify artifact SHA hashes, and preserve known-good 1.0.530 installer.
2. Upgrade only Lenovo; verify agent version, websocket, service, and 1.0.534 test manifest.
3. Runtime WGC flag OFF: user verifies VP8 desktop on iPhone Safari, input and first decoded frame. Roll back automatically on failure; DO NOT turn the flag on.
4. Once normal VP8 works, enable runtime WGC on Newtest only and request 30 FPS then 60. Collect capture arrivals, drops, conversion, actual encoded/sent FPS, WebRTC ICE/track and browser decoded/presented FPS. GDI fallback and UAC must remain functional.
5. Do not change the AWS EU infrastructure or any other tenant.

Compiled and running are **not** equivalent to qualified: the browser must display real video before promotion. The 1.0.530 working baseline remains installed until new proof.
