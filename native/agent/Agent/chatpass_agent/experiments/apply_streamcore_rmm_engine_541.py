#!/usr/bin/env python3
"""Guarded final overlay for the 1.0.537-qualified production RMM agent.
Adds an opt-in Lenovo-only StreamCore Pion/WebRTC engine, API session
binding and LocalSystem UAC. Build stays unchanged when flag is OFF.
"""
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else 'native/agent/Agent/chatpass_agent')
p=root/'src/platform/windows/windows_service.cpp'
s=p.read_text(encoding='utf-8-sig')
def replace_once(old,new,context):
 global s
 n=s.count(old)
 if n!=1:raise RuntimeError(f'{context}: expected one anchor, saw {n}')
 s=s.replace(old,new,1)
replace_once('#include "webrtc_sender.h"',
'''#include "webrtc_sender.h"
#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
#include "ipc/streamcore_rmm_transport.h"
#include "fast_capture_flags.h"
#endif''','headers')
replace_once('''            std::unique_ptr<WebRtcSender> sender;''',
'''            std::unique_ptr<WebRtcSender> sender;
#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
            std::shared_ptr<StreamCoreRmmTransport> streamcore;
#endif''','session context')
replace_once('''                        StartStreamerSession(sessionId, iceServers, sendFn, width, height, fps, bitrateKbps, sessionMode);''',
'''#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
                        if (StreamCoreRmmNewtestEligible(ident.deviceId, sessionMode)) {
                            if (StartStreamCoreRmmSession(sessionId,msg,sendFn,sessionMode,fps,bitrateKbps)){
                                LogI("StreamCore Pion RMM engine selected for authorised Lenovo console session="+sessionId);
                                FlushBridgeOutgoing();
                                return;
                            }
                            LogW("StreamCore RMM session start failed; returning to qualified original sender="+sessionId);
                        }
#endif
                        StartStreamerSession(sessionId, iceServers, sendFn, width, height, fps, bitrateKbps, sessionMode);''','session route')
replace_once('''                        if (it != sessions_.end() && it->second->sender) {
                            it->second->sender->handleSignalingMessage(text);
                        }''',
'''                        if (it != sessions_.end() && it->second->sender) {
                            it->second->sender->handleSignalingMessage(text);
                        }
#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
                        else if (it != sessions_.end() && it->second->streamcore) {
                            it->second->streamcore->Send(text);
                        }
#endif''','SDP/ICE route')
# To avoid regression to existing WebSocket fallback, forward ONLY
# approved viewer input and service shortcuts to bound core when active.
target='''                    if (type == "service_shortcut" || type == "system_shortcut" || type == "shortcut" ||
                        type == "service_command") {'''
inject='''#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
                    if (type == "input_event" || type == "service_shortcut" ||
                        type == "system_shortcut" || type == "shortcut" || type == "service_command") {
                        auto core=StreamCoreForSession(sessionId);
                        if (core) {
                            json control={{"type","rmm_control"},{"session_id",sessionId},{"input",msg}};
                            if(!core->Send(control.dump())) LogW("StreamCore RMM control pipe unavailable "+sessionId);
                            FlushBridgeOutgoing();
                            return;
                        }
                    }
#endif
'''
assert s.count(target)==1
s=s.replace(target,inject+target)
# Normal session path, before old StartStreamerSession body, bounded
# RMM-only namespace/credential gates, no lab relay references.
target='''            void StartStreamerSession(const std::string& sessionId,
'''
assert s.count(target)==1
helper='''#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
            static bool StreamCoreRmmNewtestEligible(const std::string& deviceId,SessionMode mode) {
                if (mode != SessionMode::Console ||
                    deviceId != "8b416bc2-ba5a-42d0-9b43-777a6f47af20" ||
                    !hi5::EnabledProcessOrMachineCanary("HI5_RMM_STREAMCORE_ENGINE")) return false;
                wchar_t hostname[MAX_COMPUTERNAME_LENGTH+1]{};
                DWORD n=MAX_COMPUTERNAME_LENGTH+1;
                return GetComputerNameW(hostname,&n) &&
                       _wcsicmp(hostname,L"DESKTOP-Q9LTF1M")==0;
            }
            std::shared_ptr<StreamCoreRmmTransport> StreamCoreForSession(const std::string& sid) {
                std::lock_guard<std::mutex> lock(sessionsMu_);
                auto it=sessions_.find(sid);
                if(it==sessions_.end())return {};
                return it->second->streamcore;
            }
            bool StartStreamCoreRmmSession(const std::string& sessionId,
                const json& request,const WebRtcSender::SignalSendFn& sendFn,
                SessionMode mode,int fps,int bitrateKbps) {
                if(mode!=SessionMode::Console || !StreamCoreRmmTransport::ValidSessionID(sessionId))
                    return false;
                if(!request.contains("iceServers") || !request["iceServers"].is_array())
                    return false;
                const auto bin=std::filesystem::path(CurrentExePath()).parent_path()/
                    "Hi5StreamCore-RMM-Engine-Win64.exe";
                if(!std::filesystem::is_regular_file(bin)) {
                    LogW("StreamCore RMM companion absent; original sender retained");
                    return false;
                }
                auto core=std::make_shared<StreamCoreRmmTransport>(sessionId,
                    [sendFn,sessionId](const std::string& wire){
                        const auto parsed=json::parse(wire,nullptr,false);
                        if(parsed.is_discarded()||!parsed.is_object()||
                           parsed.value("session_id",std::string())!=sessionId)return;
                        const std::string type=parsed.value("type",std::string());
                        if(type!="webrtc_offer" && type!="ice_candidate" &&
                           type!="diagnostic" && type!="profile_selected" &&
                           type!="stream_failed" && type!="encoder_applied" &&
                           type!="capture_started" && type!="streamcore_rmm_ready")
                            return;
                        sendFn(wire);
                    });
                if(!core->Start(bin.string())) {
                    LogW("StreamCore RMM SYSTEM/session pipe did not establish");
                    return false;
                }
                StopSession(sessionId);
                auto ctx=std::make_unique<SessionContext>();
                ctx->sessionId=sessionId;
                ctx->sessionMode=mode;
                ctx->activeMode=DesktopMode::Normal;
                ctx->activeConsoleSessionId=ActiveConsoleSessionId();
                ctx->streamcore=core;
                {
                    std::lock_guard<std::mutex> lock(sessionsMu_);
                    sessions_[sessionId]=std::move(ctx);
                }
                json begin={
                  {"type","rmm_authorized_start"},
                  {"session_id",sessionId},
                  {"iceServers",request["iceServers"]},
                  {"browserCodecs",request.value("browserCodecs",json::array())},
                  {"browserFamily",request.value("browserFamily",std::string("other"))},
                  {"fps",fps},
                  {"bitrateKbps",bitrateKbps},
                  {"maxWidth",0},
                  {"displayHz",0}
                };
                if(!core->Send(begin.dump())){
                    LogW("StreamCore RMM authorised start rejected, using old agent sender");
                    StopSession(sessionId);
                    return false;
                }
                LogI("StreamCore RMM engine launched under session-bound LocalSystem "+sessionId);
                return true;
            }
#endif
'''
s=s.replace(target,helper+target)
anchor='''                ctx->framePumpStop.store(true);

                if (ctx->normalStopEvent)'''
assert s.count(anchor)==1
s=s.replace(anchor,'''                ctx->framePumpStop.store(true);
#ifdef HI5_ENABLE_STREAMCORE_RMM_BUILD
                if (ctx->streamcore) {
                    ctx->streamcore->Stop();
                    ctx->streamcore.reset();
                }
#endif
                if (ctx->normalStopEvent)''',1)
p.write_text(s,encoding='utf-8')
# Build script option remains OFF in all qualified prior releases.
p=root/'CMakeLists.txt';s=p.read_text()
anchor='''hi5_use_static_msvc_runtime(native_vp8_stream)'''
assert s.count(anchor)==1
s=s.replace(anchor,anchor+'''
# Opt-in Newtest Lenovo production RMM Pion/WebRTC sender.
# No global agent release/ITSM change unless explicitly enabled in CI.
option(HI5_ENABLE_STREAMCORE_RMM "Build scoped StreamCore RMM sidecar IPC" OFF)
if(WIN32 AND HI5_ENABLE_STREAMCORE_RMM)
  target_sources(native_vp8_stream PRIVATE src/ipc/streamcore_rmm_transport.cpp)
  target_compile_definitions(native_vp8_stream PRIVATE HI5_ENABLE_STREAMCORE_RMM_BUILD=1)
  message(STATUS "Hi5Central StreamCore RMM Pion canary COMPILED, runtime opt-in only")
endif()
''')
p.write_text(s)
p=root/'installer/windows/Build-AgentInstaller.ps1';s=p.read_text(encoding='utf-8-sig')
needle='''    [switch]$EnableWgc154Canary'''
assert s.count(needle)==1
s=s.replace(needle,'''    [switch]$EnableWgc154Canary,
    [switch]$EnableStreamCoreRmm''')
needle='''$wgc154Cmake = if ($EnableWgc154Canary) { "ON" } else { "OFF" }'''
assert s.count(needle)==1
s=s.replace(needle,needle+'''
$streamCoreRmmCmake = if ($EnableStreamCoreRmm) { "ON" } else { "OFF" }''')
needle='''    "-DHI5_ENABLE_WGC154_CANARY=$wgc154Cmake"'''
assert s.count(needle)==1
s=s.replace(needle,needle+''',
    "-DHI5_ENABLE_STREAMCORE_RMM=$streamCoreRmmCmake"''')

# Standard Inno Setup /DSourceDir resolves to the build output, not
# installer/windows. Stage exactly the SHA-pinned helpers into build output.
copy_anchor = '$env:HI5_AGENT_VERSION = $AgentVersion'
assert s.count(copy_anchor)==1
copy_block = r"""if ($EnableStreamCoreRmm) {
    $sourceCompanions = Join-Path $scriptDir 'streamcore-541'
    $targetCompanions = Join-Path $buildPath 'streamcore-541'
    $manifestPath = Join-Path $sourceCompanions 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw 'Pinned StreamCore RMM payload missing from source tree'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.scope -cne 'DESKTOP-Q9LTF1M' -or $manifest.rmmAgentBaseline -cne '1.0.537') {
        throw 'Wrong RMM StreamCore source scope'
    }
    New-Item -ItemType Directory -Force -Path $targetCompanions | Out-Null
    foreach ($file in $manifest.files.PSObject.Properties) {
        if ($file.Name -notmatch '^[A-Za-z0-9-]+[.]exe$') { throw 'Unexpected companion filename' }
        $src = Join-Path $sourceCompanions $file.Name
        $dst = Join-Path $targetCompanions $file.Name
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw 'RMM StreamCore companion missing' }
        if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$file.Value) {
            throw ('RMM StreamCore companion hash changed: ' + $file.Name)
        }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$file.Value) {
            throw ('RMM StreamCore installer payload mismatch: ' + $file.Name)
        }
    }
}
"""
s=s.replace(copy_anchor,copy_block+'\n'+copy_anchor)
p.write_text(s,encoding='utf-8')
# The sidecar and exact v048 qualified media companions are packaged
# in the same signed-off Inno payload as agent 541; there is no separate
# StreamCore test service, second login or manual EXE.
p=root/'installer/windows/Hi5CentralAgentSetup.iss'
s=p.read_text(encoding='utf-8-sig')
files=['Hi5StreamCore-RMM-Engine-Win64.exe',
       'Hi5StreamCore-DefaultGDI-CPU-v048-Win64.exe',
       'Hi5StreamCore-SecureGDI-CPU-v048-Win64.exe',
       'Hi5StreamCore-SystemLauncher-CPU-v048-Win64.exe',
       'Hi5StreamCore-SessionControls-CPU-v048-Win64.exe',
       'Hi5StreamCore-MF-HardwareProbe-v03-Win64.exe']
needle='[Files]\n'
assert s.count(needle)==1
entries=''.join(
 f'Source: "{{#SourceDir}}\\streamcore-541\\{name}"; DestDir: "{{app}}"; DestName: "{name}"; Flags: ignoreversion\n'
 for name in files
)
s=s.replace(needle,needle+entries)
assert s.count('streamcore-541')==6
p.write_text(s,encoding='utf-8')
print('PASS: guarded StreamCore RMM 541 service route, pinned Inno components, original sender fallback, option default OFF')
