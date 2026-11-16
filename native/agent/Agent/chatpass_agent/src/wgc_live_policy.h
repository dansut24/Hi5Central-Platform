#pragma once
namespace hi5 {
// Opt-in first canary: never capture a secure desktop, SYSTEM desktop,
// background console, backstage helper, secondary monitor or all-monitor
// composite. All failures use the separately qualified GDI path.
constexpr bool WgcLiveEligible(bool enabled,bool isSystem,
    bool interactiveConsole,bool defaultUserDesktop,
    bool secureDesktop,bool secureHelper,int displayIndex) noexcept {
    return enabled && !isSystem && interactiveConsole &&
           defaultUserDesktop && !secureDesktop && !secureHelper &&
           displayIndex == 0;
}
} // namespace hi5
