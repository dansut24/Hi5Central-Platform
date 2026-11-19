# Agent 1.0.533 — correction of compiled Windows screen capture

The last tested canary (1.0.532) repeatedly died during DesktopFrameSource construction, before WGC capture was started, both with feature flag ON and OFF.

Cause candidates found in the **compiled** src/platform/windows/windows_screen.cpp:
- unsafe WideCharToMultiByte conversion allocated only (len-1) bytes but wrote len;
- DXGI duplication failures threw exceptions rather than falling back to GDI.

The repository already contained a corrected src/frame_source.cpp from commit 5ba11c5 ("Fix Windows Remote streamer crash when DXGI is unavailable"), but CMake builds the older src/platform/windows/windows_screen.cpp, not src/frame_source.cpp. This patch replaces the compiled Windows implementation with the corrected existing source, without changing the 1.0.532 diagnostic checkpoints, WebRTC, VP8, authentication, UAC, or feature flags. The canary remains OFF by default.

Build and test only on DESKTOP-Q9LTF1M in Newtest. Preserve working v1.0.530. First prove ordinary VP8 with feature OFF; only then activate WGC and 30/60fps. Automatic rollback remains required if video fails.
