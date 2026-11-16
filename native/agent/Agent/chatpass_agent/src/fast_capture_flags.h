#pragma once
#include <cstdlib>
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#endif

namespace hi5 {
// Default-off, machine-scoped diagnostic canary. Explicit value "1" only.
// Windows child processes may inherit an older service environment (notably
// HI5_STREAM_FPS=30), so read the registry machine environment as well.
// No registry writes, broadcasts, token operations or global setting changes.
inline bool EnabledProcessOrMachineCanary(const char* name) noexcept {
    if (!name || !*name) return false;
#ifdef _WIN32
    char inherited[16]{};
    const DWORD n = GetEnvironmentVariableA(name, inherited,
                                            sizeof(inherited));
    if (n == 1 && inherited[0] == '1') return true;
    char machine[16]{};
    DWORD size = sizeof(machine);
    DWORD type = 0;
    const LONG error = RegGetValueA(
        HKEY_LOCAL_MACHINE,
        R"(SYSTEM\CurrentControlSet\Control\Session Manager\Environment)",
        name, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
        &type, machine, &size);
    return error == ERROR_SUCCESS && size >= 2 &&
           machine[0] == '1' && machine[1] == '\0';
#else
    const char* value = std::getenv(name);
    return value && std::strcmp(value, "1") == 0;
#endif
}
} // namespace hi5
