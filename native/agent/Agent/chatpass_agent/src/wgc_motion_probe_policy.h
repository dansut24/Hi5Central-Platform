#pragma once
#include <algorithm>
#include <cstdint>

namespace hi5 {
// Stage 2N uses an exit-code-only protocol. 9-bit received frames, 9-bit
// actual UI repaints, 5-bit mean readback ms, 5-bit max readback ms.
// For a 6-second run at up to 60 Hz, neither frame nor paint fields saturate.
constexpr std::uint32_t kWgcMotionMarker = 0xB0000000u;
constexpr unsigned kWgcMotionWindowMs = 6000u;
constexpr unsigned kWgcMotionMaxFrames = 511u;
inline bool WgcMotionTargetAllowed(unsigned target) noexcept {
    return target == 15u || target == 30u || target == 60u;
}
inline std::uint32_t PackWgcMotionMetrics(
        unsigned frames, unsigned paints, unsigned avgMs,
        unsigned maxMs) noexcept {
    return kWgcMotionMarker |
        (std::min(frames, 511u) << 19) |
        (std::min(paints, 511u) << 10) |
        (std::min(avgMs, 31u) << 5) |
        std::min(maxMs, 31u);
}
inline bool WgcMotionMetricsValid(std::uint32_t code) noexcept {
    return (code & 0xF0000000u) == kWgcMotionMarker &&
           ((code >> 10) & 511u) > 0;
}
inline unsigned WgcMotionFrames(std::uint32_t code) noexcept {
    return (code >> 19) & 511u;
}
inline unsigned WgcMotionPaints(std::uint32_t code) noexcept {
    return (code >> 10) & 511u;
}
inline unsigned WgcMotionMeanMs(std::uint32_t code) noexcept {
    return (code >> 5) & 31u;
}
inline unsigned WgcMotionMaxMs(std::uint32_t code) noexcept {
    return code & 31u;
}
inline unsigned WgcMotionTargetFrames(unsigned target) noexcept {
    return WgcMotionTargetAllowed(target)
        ? target * kWgcMotionWindowMs / 1000u : 0u;
}
} // namespace hi5
