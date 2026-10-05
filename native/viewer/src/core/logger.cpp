#include "core/logger.h"

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>

namespace hi5 {
namespace {
std::mutex g_logMutex;

std::string TimestampNow() {
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto t = system_clock::to_time_t(now);

    std::tm tm{};
#ifdef _WIN32
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif

    std::ostringstream oss;
    oss << std::put_time(&tm, "%H:%M:%S");
    return oss.str();
}

std::filesystem::path LogDirectory() {
#ifdef _WIN32
    if (const char* localAppData = std::getenv("LOCALAPPDATA"); localAppData && *localAppData) {
        return std::filesystem::path(localAppData) / "Hi5Central" / "Viewer";
    }
#elif defined(__APPLE__)
    if (const char* home = std::getenv("HOME"); home && *home) {
        return std::filesystem::path(home) / "Library" / "Logs" / "Hi5Central" / "Viewer";
    }
#else
    if (const char* xdgState = std::getenv("XDG_STATE_HOME"); xdgState && *xdgState) {
        return std::filesystem::path(xdgState) / "hi5central" / "viewer";
    }
    if (const char* home = std::getenv("HOME"); home && *home) {
        return std::filesystem::path(home) / ".local" / "state" / "hi5central" / "viewer";
    }
#endif
    return {};
}

void LogLine(const char* level, const std::string& message) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    const std::string line = TimestampNow() + " [" + level + "] " + message;
    std::cout << line << std::endl;

    try {
        const auto logDir = LogDirectory();
        if (!logDir.empty()) {
            std::filesystem::create_directories(logDir);
            std::ofstream out(logDir / "viewer.log", std::ios::app);
            if (out) out << line << '\n';
        }
    } catch (...) {
        // Logging must never affect Viewer startup.
    }
}
}

void LogInfo(const std::string& message) { LogLine("INFO", message); }
void LogWarn(const std::string& message) { LogLine("WARN", message); }
void LogError(const std::string& message) { LogLine("ERROR", message); }

} // namespace hi5