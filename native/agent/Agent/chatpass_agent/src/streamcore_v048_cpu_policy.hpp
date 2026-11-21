#pragma once
// Production RMM agent canary: native-resolution GDI and exact-frame
// elision ported from StreamCore v0.3.17, OFF by default. No encoder,
// signaling, session or UAC protocol changes.
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace hi5::streamcore048 {
inline bool NativeBlit(bool enabled, int srcW, int srcH, int dstW, int dstH) noexcept {
    return enabled && srcW > 0 && srcH > 0 && srcW == dstW && srcH == dstH;
}
inline bool ExactSameBGRA(const uint8_t* lhs, std::size_t lhsBytes,
                          const uint8_t* rhs, std::size_t rhsBytes) noexcept {
    return lhs && rhs && lhsBytes && lhsBytes == rhsBytes &&
           std::memcmp(lhs, rhs, lhsBytes) == 0;
}
inline bool HeartbeatDue(std::chrono::steady_clock::time_point now,
                         std::chrono::steady_clock::time_point last,
                         int ms = 500) noexcept {
    return last == std::chrono::steady_clock::time_point{} ||
           now - last >= std::chrono::milliseconds(ms);
}
} // namespace hi5::streamcore048
