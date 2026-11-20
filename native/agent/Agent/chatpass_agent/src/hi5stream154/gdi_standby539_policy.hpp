// Hi5Central Newtest 539: conservative normal-desktop GDI standby gate.
// The USER WGC helper produces video; the existing SYSTEM helper retains input,
// UAC and GDI fallback. Header-only so security gates are unit-testable.
#pragma once
#include <cstdint>

namespace hi5stream {
inline bool ShouldStandbyGdi539(
    bool enabled,
    bool authorizedNewtest,
    bool wgcUserHelperAlive,
    bool normalDesktop,
    bool uacRequested,
    bool backstage,
    bool consoleSwitch,
    int displayIndex,
    int64_t lastWgcFrameAgeMs) noexcept {
    return enabled && authorizedNewtest && wgcUserHelperAlive &&
        normalDesktop && !uacRequested && !backstage && !consoleSwitch &&
        displayIndex==0 && lastWgcFrameAgeMs>=0 &&
        lastWgcFrameAgeMs<220;
}
}
