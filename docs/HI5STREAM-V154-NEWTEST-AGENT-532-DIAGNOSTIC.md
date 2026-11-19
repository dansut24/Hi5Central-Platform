# Hi5Stream v0.15.4 / Agent 1.0.532 diagnostic canary

Newtest Lenovo DESKTOP-Q9LTF1M only. Do NOT deploy to production or any fleet.

Agent 1.0.531 was rolled back to 1.0.530 because both normal and secure streamer helpers crashed with 0xC0000409. Windows Application event ID 1000 recorded identical fault offset 0x006660d9 on 18 November 2026. This failure happened with the WGC feature flag both OFF and ON. Existing VP8/libvpx, WebRTC, UAC, identity, installer rollback remain unchanged.

This candidate restores the legacy agent compilation mode to C++17 while compiling only the new WinRT WGC implementation as C++20, and adds startup checkpoints around DesktopFrameSource creation, monitor enumeration and IPC publishing. This is a hypothesis/test, not a confirmed crash fix.

Keep the stable 1.0.530 agent installed while the diagnostic build is compiled, reviewed, and a controlled single-host test is scheduled. The C++ capture engine is the source of truth; no fabricated FPS or session health.
