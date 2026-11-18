// Copyright (c) 2026 Hi5Central. Proprietary isolated Newtest canary policy.
// No network/auth/service behavior: this guards only video capture selection.
#pragma once
#include <string>
#include <string_view>
namespace hi5 {
struct Wgc154PolicyDecision {
    bool enabled=false;
    const char* reason="flag-off";
};
inline Wgc154PolicyDecision EvaluateWgc154Canary(
    bool flagEnabled,std::string_view hostname,bool secureHelper,
    bool secureDesktop,int displayIndex,int viewerFps) noexcept {
    if(!flagEnabled)return {false,"flag-off"};
    // This fixed Lenovo allowlist cannot be widened through an env variable.
    // Staging package is only distributed to the Newtest tenant/device.
    if(hostname!="DESKTOP-Q9LTF1M")return {false,"host-not-allowlisted"};
    if(secureHelper)return {false,"secure-helper-protected"};
    if(secureDesktop)return {false,"secure-desktop-protected"};
    if(displayIndex!=0)return {false,"monitor-not-qualified"};
    if(viewerFps!=15 && viewerFps!=30 &&
       viewerFps!=45 && viewerFps!=60)
        return {false,"fps-not-qualified"};
    return {true,"qualified-normal-desktop"};
}
} // namespace hi5
