#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include "bgra_luma_sse2.h"

namespace hi5 {
// Stage 2O: isolated, default-OFF BGRA -> I420 fast conversion.
// Uses the exact legacy coefficients, rounding, per-pixel U/V formulas and
// arithmetic integer-average ordering to preserve qualified colours/text.
// Y uses the separately tested SSE2 path; U/V use 2x2 unrolled rows.
// No new DLL, runtime architecture, streamer threads, or GPU dependencies.
inline bool BgraToI420FastPlanes(
    const std::uint8_t* bgra, int stride, int width, int height,
    std::uint8_t* yPlane, std::uint8_t* uPlane,
    std::uint8_t* vPlane) noexcept {
    if (!bgra || !yPlane || !uPlane || !vPlane || width <= 0 ||
        height <= 0 || stride <= 0 ||
        static_cast<std::int64_t>(stride) < static_cast<std::int64_t>(width) * 4 ||
        width > 8192 || height > 4320)
        return false;
    for (int py = 0; py < height; ++py) {
        BgraLumaRowSse2(bgra + static_cast<std::size_t>(py) * stride,
                         yPlane + static_cast<std::size_t>(py) * width,
                         width);
    }
    const int uvStride = (width + 1) / 2;
    const int uvHeight = (height + 1) / 2;
    auto uv = [](const std::uint8_t* p, int& u, int& v) noexcept {
        const int b = p[0], g = p[1], r = p[2];
        u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    };
    auto clamp = [](int a) noexcept -> std::uint8_t {
        return static_cast<std::uint8_t>(std::max(0,std::min(255,a)));
    };
    for (int cy = 0; cy < uvHeight; ++cy) {
        const int srcY = cy * 2;
        const auto* row0 = bgra + static_cast<std::size_t>(srcY) * stride;
        const bool hasRow1 = srcY + 1 < height;
        const auto* row1 = hasRow1 ? row0 + stride : nullptr;
        const auto dst = static_cast<std::size_t>(cy) * uvStride;
        int cx = 0;
        for (; cx < width / 2; ++cx) {
            const auto* p = row0 + static_cast<std::size_t>(cx) * 8u;
            int u0, v0, u1, v1, u2 = 0, v2 = 0, u3 = 0, v3 = 0;
            uv(p, u0, v0);
            uv(p + 4, u1, v1);
            int sumU = u0 + u1, sumV = v0 + v1, count = 2;
            if (hasRow1) {
                const auto* q = row1 + static_cast<std::size_t>(cx) * 8u;
                uv(q, u2, v2);
                uv(q + 4, u3, v3);
                sumU += u2 + u3;
                sumV += v2 + v3;
                count = 4;
            }
            uPlane[dst + cx] = clamp(sumU / count);
            vPlane[dst + cx] = clamp(sumV / count);
        }
        if (width & 1) {
            const auto* p = row0 + static_cast<std::size_t>(width - 1) * 4u;
            int u0, v0, u1 = 0, v1 = 0;
            uv(p, u0, v0);
            int count = 1;
            if (hasRow1) {
                uv(row1 + static_cast<std::size_t>(width - 1) * 4u, u1, v1);
                count = 2;
            }
            uPlane[dst + cx] = clamp((u0 + u1) / count);
            vPlane[dst + cx] = clamp((v0 + v1) / count);
        }
    }
    return true;
}
} // namespace hi5
