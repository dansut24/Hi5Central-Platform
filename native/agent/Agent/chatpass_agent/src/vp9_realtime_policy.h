#pragma once
#include <algorithm>
#include <chrono>
#include <cstdint>

namespace hi5 {
// RTP/VP9 timing follows actual monotonic capture time, not (submitted frames /
// viewer-selected FPS). A dynamically selected idle=2 / motion=60 profile must
// not stretch or compress WebRTC presentation time.
inline std::uint64_t Vp9Clock90k(
    std::chrono::steady_clock::time_point epoch,
    std::chrono::steady_clock::time_point now,
    std::uint64_t previous) noexcept {
    using namespace std::chrono;
    const auto micros = duration_cast<microseconds>(now - epoch).count();
    const std::uint64_t elapsed = micros > 0
        ? static_cast<std::uint64_t>(micros) : 0u;
    const auto timestamp = (elapsed / 100u) * 9u +
        ((elapsed % 100u) * 9u) / 100u;
    return std::max(previous + 1u, timestamp);
}
inline std::uint64_t Vp9FrameDuration90k(std::uint64_t current,
                                         std::uint64_t previous) noexcept {
    return current > previous
        ? std::min<std::uint64_t>(90000u,current - previous) : 1u;
}
inline bool Vp9SwProfileChange(int oldFps,int oldBitrate,int nextFps,
                                int nextBitrate) noexcept {
    return oldFps != nextFps || oldBitrate != nextBitrate;
}
} // namespace hi5
