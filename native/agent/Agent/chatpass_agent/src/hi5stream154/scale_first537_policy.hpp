// Hi5Central 1.0.537 Newtest-only software WGC pixel conversion experiment.
// All dimensions/flags validated before using the alternate BGRA scale-first path.
#pragma once
#include <cstdint>
#include <string_view>
namespace hi5stream {
inline bool CanUseScaleFirst537(std::string_view hostname,
                               bool newtestWgcCanaryEnabled,
                               bool userVideoOnly,
                               bool runtimeScaleFirstEnabled,
                               int sourceWidth,int sourceHeight,
                               int outputWidth,int outputHeight,
                               int display) noexcept {
    return hostname=="DESKTOP-Q9LTF1M" && newtestWgcCanaryEnabled &&
           userVideoOnly && runtimeScaleFirstEnabled &&
           sourceWidth==2560 && sourceHeight==1600 &&
           outputWidth==1280 && outputHeight==800 && display==0;
}
inline bool IsValidScaleFirst537Stride(int sourceWidth,int sourceHeight,
                                     int srcStride,int outWidth,int outHeight) noexcept {
    return sourceWidth==2560 && sourceHeight==1600 &&
           srcStride>=sourceWidth*4 && srcStride<=sourceWidth*8 &&
           outWidth==1280 && outHeight==800;
}
inline int ExpectedOutputI420Bytes537(int width,int height) noexcept {
    return (width==1280 && height==800) ? width*height*3/2 : 0;
}
}
