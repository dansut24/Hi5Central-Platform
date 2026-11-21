#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

// One authenticated production RMM remote session = one LocalSystem
// interactive StreamCore Pion process and two SYSTEM-only named pipes.
// The Agent owns all session authorization, signaling, lifecycle and audit.
// This class never opens a browser-facing listener or accepts lab tokens.
class StreamCoreRmmTransport final {
public:
 using MessageCallback = std::function<void(const std::string&)>;
 StreamCoreRmmTransport(std::string sessionID, MessageCallback callback);
 ~StreamCoreRmmTransport();
 StreamCoreRmmTransport(const StreamCoreRmmTransport&) = delete;
 StreamCoreRmmTransport& operator=(const StreamCoreRmmTransport&) = delete;
 bool Start(const std::string& trustedEngineExe);
 bool Send(const std::string& json);
 void Stop();
 bool Running() const noexcept {return running_.load();}
 const std::string& SessionID() const noexcept {return sessionID_;}
 static bool ValidSessionID(const std::string&);
private:
 void ReaderLoop();
 static HANDLE CreateRestrictedPipe(const std::wstring&,DWORD mode);
 static bool ConnectBounded(HANDLE pipe,std::thread& worker,int timeoutMillis);
 std::string sessionID_;
 MessageCallback callback_;
 HANDLE process_=nullptr;
 HANDLE fromCore_=INVALID_HANDLE_VALUE;
 HANDLE toCore_=INVALID_HANDLE_VALUE;
 std::thread reader_;
 std::mutex writing_;
 std::atomic<bool> running_{false};
 std::atomic<bool> stopped_{false};
};
