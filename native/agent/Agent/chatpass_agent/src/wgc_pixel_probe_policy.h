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
        case 0x80070005u: return "wgc_access_denied";
        default: return (code & 0x80000000u) ? "wgc_hresult_error" :
                                                     "wgc_unexpected_result";
    }
}
} // namespace hi5
