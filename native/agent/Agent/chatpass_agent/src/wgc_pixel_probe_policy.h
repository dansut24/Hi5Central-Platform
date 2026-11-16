#pragma once
#include <algorithm>
#include <cstdint>

namespace hi5 {
// Exit-code encoding is kept separate from the existing Stage 2K frame-arrival
// marker. The result is metrics-only; never pixel data or an image payload.
constexpr std::uint32_t kWgcPixelMarker = 0x6b000001u;
inline bool WgcPixelDimensionsAllowed(unsigned width, unsigned height,
                                      unsigned rowPitch) noexcept {
    if (!width || !height || width > 8192 || height > 4320) return false;
    const std::uint64_t rowBytes = static_cast<std::uint64_t>(width) * 4u;
    return rowPitch >= rowBytes &&
           rowBytes * static_cast<std::uint64_t>(height) <= 128ull * 1024ull * 1024ull;
}
inline std::uint32_t PackWgcPixelFrames(unsigned frames,
                                        unsigned averageReadbackMs,
                                        unsigned maximumReadbackMs) noexcept {
    return kWgcPixelMarker |
        (std::min(frames, 255u) << 16) |
        (std::min(averageReadbackMs, 255u) << 8) |
        (std::min(maximumReadbackMs, 127u) << 1);
}
inline bool WgcPixelHasFrames(std::uint32_t code) noexcept {
    return (code & 0xff000001u) == kWgcPixelMarker &&
           ((code >> 16) & 255u) > 0u;
}
inline unsigned WgcPixelFrames(std::uint32_t code) noexcept {
    return (code >> 16) & 255u;
}
inline unsigned WgcPixelAverageReadbackMs(std::uint32_t code) noexcept {
    return (code >> 8) & 255u;
}
inline unsigned WgcPixelMaximumReadbackMs(std::uint32_t code) noexcept {
    return (code >> 1) & 127u;
}
// Stage 2M: 32-bit child exit values carry *metrics only*. This keeps
// frame pixels private to the short-lived interactive-user process.
// 14-bit width, 13-bit height, five marker bits: up to 8192 x 4320.
constexpr std::uint32_t kWgcResolutionMarker = 0xD8000000u;
inline std::uint32_t PackWgcResolution(unsigned width,
                                       unsigned height) noexcept {
    return kWgcResolutionMarker |
           (std::min(width, 8192u) << 13) |
           std::min(height, 4320u);
}
inline bool WgcResolutionValid(std::uint32_t code) noexcept {
    if ((code & 0xF8000000u) != kWgcResolutionMarker) return false;
    const unsigned width = (code >> 13) & 0x3FFFu;
    const unsigned height = code & 0x1FFFu;
    return width > 0 && width <= 8192u && height > 0 && height <= 4320u;
}
inline unsigned WgcResolutionWidth(std::uint32_t code) noexcept {
    return (code >> 13) & 0x3FFFu;
}
inline unsigned WgcResolutionHeight(std::uint32_t code) noexcept {
    return code & 0x1FFFu;
}
// 10 bits frames, 8 bits avg ms and 8 bits max ms; upper six marker bits.
constexpr std::uint32_t kWgcSustainedMarker = 0xC4000000u;
inline std::uint32_t PackWgcSustained(unsigned frames, unsigned avgMs,
                                     unsigned maxMs) noexcept {
    return kWgcSustainedMarker |
        (std::min(frames, 1023u) << 16) |
        (std::min(avgMs, 255u) << 8) |
        std::min(maxMs, 255u);
}
inline bool WgcSustainedValid(std::uint32_t code) noexcept {
    return (code & 0xFC000000u) == kWgcSustainedMarker &&
           ((code >> 16) & 0x3FFu) != 0;
}
inline unsigned WgcSustainedFrames(std::uint32_t code) noexcept {
    return (code >> 16) & 0x3FFu;
}
inline unsigned WgcSustainedAvgReadbackMs(std::uint32_t code) noexcept {
    return (code >> 8) & 0xFFu;
}
inline unsigned WgcSustainedMaxReadbackMs(std::uint32_t code) noexcept {
    return code & 0xFFu;
}

inline const char* WgcPixelFailure(std::uint32_t code) noexcept {
    switch (code) {
        case 101: return "not_interactive_user";
        case 102: return "console_session_mismatch";
        case 103: return "thread_not_default";
        case 104: return "station_not_winsta0";
        case 105: return "input_desktop_not_default";
        case 301: return "wgc_not_supported";
        case 302: return "primary_monitor_missing";
        case 303: return "capture_item_failed";
        case 304: return "d3d11_device_failed";
        case 305: return "winrt_device_failed";
        case 306: return "frame_pool_failed";
        case 307: return "capture_session_failed";
        case 308: return "capture_start_failed";
        case 309: return "no_pixels_copied";
        case 310: return "readback_failed";
        case 311: return "readback_dimensions_unsafe";
        case 312: return "frame_callback_failed";
        case 313: return "source_texture_unavailable";
        case 314: return "texture_dimensions_changed_during_probe";
        case 0x80070005u: return "wgc_access_denied";
        default: return (code & 0x80000000u) ? "wgc_hresult_error" :
                                                     "wgc_unexpected_result";
    }
}
} // namespace hi5
