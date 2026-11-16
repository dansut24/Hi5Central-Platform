#pragma once
#include "bgra_to_i420_fast.h"
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

namespace hi5 {
// Explicit on-demand synthetic benchmark only. No screen data is read.
// Compare the legacy exact scalar converter with the fast path at 2560x1600,
// on the actual Lenovo CPU. The full readback/encoder pipeline is NOT timed.
inline int RunBgraI420Microbenchmark() {
    constexpr int width = 2560, height = 1600, stride = width * 4;
    const std::size_t pixels = static_cast<std::size_t>(width) * height;
    std::vector<std::uint8_t> bgra(pixels * 4);
    std::uint32_t random = 0x2cc75a52u;
    for (auto& b : bgra) {
        random ^= random << 13; random ^= random >> 17; random ^= random << 5;
        b = static_cast<std::uint8_t>(random);
    }
    const std::size_t uvSize = pixels / 4;
    std::vector<std::uint8_t> yFast(pixels), uFast(uvSize), vFast(uvSize),
                              yOld(pixels), uOld(uvSize), vOld(uvSize);
    auto clamp = [](int x) noexcept -> std::uint8_t {
        return static_cast<std::uint8_t>(std::max(0,std::min(255,x)));
    };
    auto scalar = [&]() {
        for (int row = 0; row < height; ++row) {
            const auto* p = bgra.data() + static_cast<std::size_t>(row)*stride;
            for(int x=0; x<width; ++x) {
                const int b=p[x*4],g=p[x*4+1],r=p[x*4+2];
                yOld[static_cast<std::size_t>(row)*width+x] =
                    clamp(((66*r+129*g+25*b+128)>>8)+16);
            }
        }
        for (int by=0; by<height/2; ++by) {
            for (int bx=0; bx<width/2; ++bx) {
                int su=0,sv=0,count=0;
                for(int dy=0;dy<2;++dy)for(int dx=0;dx<2;++dx) {
                    const auto* p=bgra.data() +
                        static_cast<std::size_t>(by*2+dy)*stride+(bx*2+dx)*4;
                    const int b=p[0],g=p[1],r=p[2];
                    su+=((-38*r-74*g+112*b+128)>>8)+128;
                    sv+=((112*r-94*g-18*b+128)>>8)+128; ++count;
                }
                const auto pos=static_cast<std::size_t>(by)*(width/2)+bx;
                uOld[pos]=clamp(su/count);
                vOld[pos]=clamp(sv/count);
            }
        }
    };
    auto fast = [&]() {
        if (!BgraToI420FastPlanes(bgra.data(),stride,width,height,
                                  yFast.data(),uFast.data(),vFast.data()))
            throw std::runtime_error("fast_i420_failed");
    };
    scalar(); fast();
    const bool exact = yOld==yFast && uOld==uFast && vOld==vFast;
    if(!exact) {
        std::cout<<"HI5_I420_BENCHMARK status=failed reason=pixel_mismatch\n";
        return 13;
    }
    using clock = std::chrono::steady_clock;
    auto benchmark = [&](auto&& fn,int repetitions) {
        double total=0,maxMs=0;
        for(int i=0;i<repetitions;++i) {
            const auto start=clock::now();fn();
            const double ms=std::chrono::duration<double,std::milli>(
                clock::now()-start).count();
            total+=ms;maxMs=std::max(maxMs,ms);
        }
        return std::pair<double,double>{total/repetitions,maxMs};
    };
    fast();fast();
    const auto legacy=benchmark(scalar,4);
    const auto optimized=benchmark(fast,12);
    std::cout<<std::fixed<<std::setprecision(3)
             <<"HI5_I420_BENCHMARK status=completed"
             <<" width="<<width<<" height="<<height
             <<" legacy_scalar_avg_ms="<<legacy.first
             <<" fast_sse2_avg_ms="<<optimized.first
             <<" fast_sse2_max_ms="<<optimized.second
             <<" pixel_exact=1"
             <<" synthetic_pixels_only=1"
             <<" network_frames_sent=0"
             <<" live_capture_unchanged=1\n";
    return 0;
}
} // namespace hi5
