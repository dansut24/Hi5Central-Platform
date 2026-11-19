// Hi5Central Newtest-only WGC recovery + native VP8 high-FPS policy (v1.0.536).
// Pure C++17: deterministic testable decisions; legacy 1.0.535 unaffected by default.
#pragma once
#include <cstdint>
#include <algorithm>

namespace hi5stream {
inline bool Wgc536NormalReady(bool enabled, bool normalHelperAlive,
    bool uacActive, bool secureHelperAlive, bool activeNormal,
    bool backstage, bool consoleSwitch, bool consoleSessionMatch,
    int display, bool freshNormalCapture) noexcept {
    return enabled && normalHelperAlive && !uacActive &&
        !secureHelperAlive && activeNormal && !backstage &&
        !consoleSwitch && consoleSessionMatch && display == 0 &&
        freshNormalCapture;
}
inline unsigned Wgc536RetryDelayMs(unsigned attempts) noexcept {
    switch (attempts) {
      case 0: return 2000u;
      case 1: return 5000u;
      case 2: return 10000u;
      default: return 30000u;
    }
}
inline bool Wgc536ShouldRetry(bool normalReady, int64_t normalStableMs,
    int64_t sinceLastAttemptMs, unsigned previousAttempts) noexcept {
    return normalReady && normalStableMs >= 900 &&
           sinceLastAttemptMs >= static_cast<int64_t>(
               Wgc536RetryDelayMs(previousAttempts));
}
inline int Wgc536Vp8Fps(bool userWgcFresh, bool secure, bool backstage,
    int effectiveMode, int selectedFps, int legacyProfileFps) noexcept {
    if (!userWgcFresh || secure || backstage || effectiveMode != 2)
        return legacyProfileFps;
    if (selectedFps != 15 && selectedFps != 30 &&
        selectedFps != 45 && selectedFps != 60)
        return legacyProfileFps;
    return selectedFps;
}
} // namespace hi5stream
