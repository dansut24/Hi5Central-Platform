#pragma once
#include <algorithm>
#include <cstdint>

namespace hi5 {
struct GdiDirectTarget {
    int width=0;
    int height=0;
    bool scaled=false;
};

// The capture target is a bounding rectangle, NOT a forced 16:9 aspect.
// A 2560x1600 desktop remains 16:10 at 1728x1080; mouse mapping and text
// geometry are unchanged. Default-OFF canary never enlarges an image.
inline GdiDirectTarget GdiDirectTarget1080(int nativeWidth,int nativeHeight,
                                           bool enabled) noexcept {
    if(nativeWidth<=0 || nativeHeight<=0 || nativeWidth>16384 ||
       nativeHeight>16384)return {};
    if(!enabled || (nativeWidth<=1920 && nativeHeight<=1080))
        return {nativeWidth,nativeHeight,false};
    const std::int64_t widthLimit=static_cast<std::int64_t>(1920)*nativeHeight;
    const std::int64_t heightLimit=static_cast<std::int64_t>(1080)*nativeWidth;
    // Use integer arithmetic; round down to the next even pixel for I420.
    std::int64_t w=0,h=0;
    if(widthLimit<=heightLimit){
        w=1920;
        h=static_cast<std::int64_t>(nativeHeight)*1920/nativeWidth;
    }else{
        h=1080;
        w=static_cast<std::int64_t>(nativeWidth)*1080/nativeHeight;
    }
    w=std::max<std::int64_t>(2,std::min<std::int64_t>(1920,w)&~1ll);
    h=std::max<std::int64_t>(2,std::min<std::int64_t>(1080,h)&~1ll);
    return {static_cast<int>(w),static_cast<int>(h),true};
}
inline bool GdiDirectEligible(bool flag,bool defaultInputDesktop,
                             int selectedMonitor,bool secureHelper) noexcept {
    return flag && defaultInputDesktop && selectedMonitor==0 &&
           !secureHelper;
}
} // namespace hi5
