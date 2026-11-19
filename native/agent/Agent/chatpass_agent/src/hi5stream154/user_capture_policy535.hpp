// Copyright (c) 2026 Hi5Central. Newtest-only user WGC source policy.
#pragma once
#include <cstdint>
#include <string_view>
namespace hi5stream {
inline bool AllowUserWgc535(std::string_view hostname, bool ownerEnabled,
    bool backstage, int display, int fps, bool activeConsole) noexcept {
    return hostname=="DESKTOP-Q9LTF1M" && ownerEnabled && activeConsole &&
           !backstage && display==0 &&
           (fps==15 || fps==30 || fps==45 || fps==60);
}
inline bool ValidWgc535I420(int width,int height,std::uint64_t y,
                            std::uint64_t u,std::uint64_t v) noexcept {
    constexpr int w=1280,h=800;
    return width==w && height==h && y==w*h &&
           u==(w/2)*(h/2) && v==(w/2)*(h/2);
}
inline bool PreferWgc535(bool userFrameFresh,bool secureActive,
                         bool backstage,int display) noexcept {
    return userFrameFresh && !secureActive && !backstage && display==0;
}
} // namespace hi5stream
