#!/usr/bin/env python3
"""Newtest 1.0.535: isolate WinRT WGC capture under signed-in user.

Run after the qualified 530 replay AND the 534 opt-in overlay. The original
SYSTEM streamer retains input, UAC, secure desktop and its GDI fallback.
Only an additional, separate user-token VIDEO-ONLY helper writes to its OWN
shared-memory ring. The service selects valid fresh user frames or its normal
qualified 530 frames. Fail closed if the expected source layout changes.
"""
import argparse
from pathlib import Path
import hashlib

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def once(s,old,new,label):
 n=s.count(old)
 if n!=1:raise RuntimeError(f"535 {label}: expected one source anchor, got {n}")
 return s.replace(old,new,1)
def main():
 ap=argparse.ArgumentParser()
 ap.add_argument("--root",required=True)
 a=ap.parse_args()
 root=Path(a.root).resolve();src=root/"src"
 streamer=src/"streamer_main.cpp"
 service=src/"platform/windows/windows_service.cpp"
 sender=src/"webrtc_sender.cpp"
 launcher=src/"ipc/session_launcher.cpp"
 policy=src/"hi5stream154/user_capture_policy535.hpp"
 assert policy.exists(),"535 pure policy missing"
 before={str(p):digest(p) for p in (sender,launcher,src/"platform/windows/windows_screen.cpp",src/"webrtc_sender.h")}
 st=streamer.read_text(encoding="utf-8-sig")
 sv=service.read_text(encoding="utf-8-sig")
 if not all(x in st for x in ("HI5_STREAM_V154_WGC_CANARY","[hi5stream-534]","std::unique_ptr<hi5::Wgc154Capture>","FrameCaptureResult captured")):
  raise RuntimeError("Run the 534 isolated WGC overlay before the 535 user-context patch")
 if not all(x in sv for x in ("LaunchInElevatedDefaultSession", "LaunchInInteractiveSession", "ctx.normalShmem.ReadRawI420Frame","ShouldHoldSecureDesktop")):
  raise RuntimeError("Qualified 530 secure/legacy service source not present")
 st=once(st,'#include "hi5stream154/wgc154_capture.h"',
            '#include "hi5stream154/wgc154_capture.h"\n#include "hi5stream154/user_capture_policy535.hpp"',
            "user capture validation header")
 # The normal SYSTEM helper must NEVER call WGC. It continues input+legacy capture.
 st=once(st,'const bool wgc154Requested=ReadEnvInt("HI5_STREAM_V154_WGC_CANARY",0,0,1)==1;',
         'const bool wgc154Requested=false; // WGC moved to isolated interactive-user capture-only child',
         "disable WGC in elevated streamer")
 st=once(st,'        int display = 0;',
  '''        int display = 0;
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
        bool userWgc535CaptureOnly = false;
#endif''',"user worker arg field")
 st=once(st,'        if (auto v = GetArgValue(argc, argv, "--display")) a.display = std::stoi(*v);',
  '''        if (auto v = GetArgValue(argc, argv, "--display")) a.display = std::stoi(*v);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
        for(int i=1;i<argc;++i)
            if(std::string(argv[i])=="--wgc535-user-video-only")
                a.userWgc535CaptureOnly=true;
#endif''',"parse protected user-only mode")
 capture_only=r'''
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
        // This process must be launched with WTSQueryUserToken / CreateProcessAsUser.
        // No input pipe, privileged input, UAC or network client ever runs here.
        if(args.userWgc535CaptureOnly){
            char computer[MAX_COMPUTERNAME_LENGTH+1]{};
            DWORD chars=sizeof(computer);
            if(!GetComputerNameA(computer,&chars))
                return 51;
            std::string host(computer,chars);
            for(auto& ch:host)
                ch=static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
            char username[256]{};
            DWORD usernameChars=sizeof(username);
            if(!GetUserNameA(username,&usernameChars) ||
               _stricmp(username,"SYSTEM")==0){
                LogWarn("[hi5stream-535] user-video process MUST NOT run as SYSTEM");
                return 52;
            }
            if(!hi5stream::AllowUserWgc535(host,true,false,args.display,args.fps,true) ||
               args.shmemName.rfind("Global\\Hi5WGC535_",0)!=0 ||
               !args.inputPipeName.empty() || !args.stopEventName.empty() ||
               IsSecureDesktopActive()){
                LogWarn("[hi5stream-535] user-video security eligibility denied");
                return 53;
            }
            hi5::Wgc154Capture capture;
            std::string reason;
            if(!capture.start(reason)){
                LogWarn("[hi5stream-535] WGC start FAILED user-session reason="+reason);
                return 54;
            }
            hi5::Wgc154Metrics metrics{};
            hi5stream::AbsoluteVideoPacer pacer(static_cast<unsigned>(args.fps),
                std::chrono::steady_clock::now());
            uint64_t frames=0;
            auto report=std::chrono::steady_clock::now()+std::chrono::seconds(5);
            LogInfo("[hi5stream-535] WGC capture STARTED under interactive user session="+args.sessionId);
            while(g_running.load()){
                if(IsSecureDesktopActive()){
                    LogInfo("[hi5stream-535] user WGC stopping for secure desktop");
                    break; // SYSTEM helper handles secure desktop / UAC.
                }
                const auto now=std::chrono::steady_clock::now();
                if(now<pacer.deadline()){
                    std::this_thread::sleep_until(
                        std::min(pacer.deadline(),now+std::chrono::milliseconds(10)));
                    continue;
                }
                FrameCaptureResult frame;
                std::string error;
                if(!capture.takeLatest(frame,metrics,error,25)){
                    LogWarn("[hi5stream-535] user WGC stopped reason="+error);
                    capture.stop();
                    return 55;
                }
                if(frame.hasFrame && frame.changed){
                    if(!hi5stream::ValidWgc535I420(frame.frame.width,frame.frame.height,
                         frame.frame.y.size(),frame.frame.u.size(),frame.frame.v.size())){
                        LogWarn("[hi5stream-535] user WGC invalid I420 frame dimensions");
                        capture.stop();
                        return 56;
                    }
                    const uint64_t stamp=static_cast<uint64_t>(GetTickCount64())*1000000ull;
                    if(!shmem.WriteRawI420Frame(frame.frame,stamp)){
                        LogWarn("[hi5stream-535] user WGC shared ring write failed");
                        capture.stop();
                        return 57;
                    }
                    ++frames;
                    pacer.frame_selected(std::chrono::steady_clock::now());
                }else{
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                }
                if(std::chrono::steady_clock::now()>=report){
                    LogInfo("[hi5stream-535] user source frames_5s="+std::to_string(frames)+
                        " arrivals="+std::to_string(metrics.sourceFrames)+
                        " empty="+std::to_string(metrics.emptyPolls)+
                        " missed_slots="+std::to_string(pacer.missed_slots())+
                        " conversion_ms="+std::to_string(metrics.conversionMs)+
                        " frame_age_ms="+std::to_string(metrics.frameAgeMs));
                    frames=0;
                    report=std::chrono::steady_clock::now()+std::chrono::seconds(5);
                }
            }
            capture.stop();
            shmem.Close();
            if(stopEvent)CloseHandle(stopEvent);
            return 0;
        }
#endif
'''
 st=once(st,'        LogInfo("[streamer] raw shmem ring ready");',
     '        LogInfo("[streamer] raw shmem ring ready");\n'+capture_only,
     "early user capture-only dispatch before privileged input or GDI constructor")

 sv=once(sv,'#include "ipc/shmem_ring.h"',
    '#include "ipc/shmem_ring.h"\n#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n#include "hi5stream154/user_capture_policy535.hpp"\n#endif',
    "service user WGC policy")
 sv=once(sv,'            ShmemRing normalShmem;\n            ShmemRing secureShmem;',
 '''            ShmemRing normalShmem;
            ShmemRing secureShmem;
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
            // Independent producer; NEVER grant interactive process an input pipe.
            ShmemRing userWgc535Shmem;
            std::string userWgc535Name;
            HANDLE userWgc535Process=nullptr;
            std::chrono::steady_clock::time_point lastUserWgc535Frame{};
#endif''',
    "separate WGC producer state")
 sv=once(sv,'                ctx->secureShmemName = "Global\\\\Hi5Stream_UAC_" + prefix;',
 '''                ctx->secureShmemName = "Global\\\\Hi5Stream_UAC_" + prefix;
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                ctx->userWgc535Name = "Global\\\\Hi5WGC535_" + prefix;
#endif''',
    "dedicated WGC ring name")

 user_launch=r'''
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
            // Additional user process is *capture-only*. Existing SYSTEM
            // normal streamer retains SendInput, elevated apps, UAC, chat, etc.
            // Original 530 shmem and sender are untouched.
            void StopUserWgc535(SessionContext& ctx){
                if(ctx.userWgc535Process){
                    if(WaitForSingleObject(ctx.userWgc535Process,0)==WAIT_TIMEOUT){
                        TerminateProcess(ctx.userWgc535Process,0);
                        WaitForSingleObject(ctx.userWgc535Process,1000);
                    }
                    CloseHandle(ctx.userWgc535Process);
                    ctx.userWgc535Process=nullptr;
                }
                ctx.userWgc535Shmem.Close();
                ctx.lastUserWgc535Frame={};
            }
            bool LaunchUserWgc535(SessionContext& ctx){
                if(ctx.userWgc535Process || ctx.backstageMode ||
                   ctx.sessionMode!=SessionMode::Console)return false;
                char canary[8]{};
                const DWORD n=GetEnvironmentVariableA("HI5_STREAM_V154_WGC_CANARY",
                                      canary,static_cast<DWORD>(sizeof(canary)));
                char computer[MAX_COMPUTERNAME_LENGTH+1]{};
                DWORD chars=sizeof(computer);
                std::string host;
                if(GetComputerNameA(computer,&chars)){
                    host.assign(computer,chars);
                    for(auto& ch:host)
                        ch=static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
                }
                const bool eligible=hi5stream::AllowUserWgc535(host,
                    n==1 && canary[0]=='1',ctx.backstageMode,ctx.displayIndex,
                    ctx.fps,ActiveConsoleSessionId()!=0xFFFFFFFF);
                if(!eligible)return false;
                if(!ctx.userWgc535Shmem.CreateProducer(ctx.userWgc535Name)){
                    LogW("[hi5stream-535] user shared ring unavailable, using qualified GDI err="+
                         std::to_string(GetLastError()));
                    return false;
                }
                char exe[MAX_PATH]{};
                GetModuleFileNameA(nullptr,exe,MAX_PATH);
                std::string cmd="--mode streamer --wgc535-user-video-only --session "+
                    ctx.sessionId+" --shmem "+ctx.userWgc535Name+
                    " --display 0 --fps "+std::to_string(ctx.fps);
                ctx.userWgc535Process=LaunchInInteractiveSession(std::string(exe),cmd);
                if(!ctx.userWgc535Process){
                    LogW("[hi5stream-535] CreateProcessAsUser failed, using 530 GDI fallback");
                    ctx.userWgc535Shmem.Close();
                    return false;
                }
                LogI("[hi5stream-535] dedicated capture-only interactive USER helper launched"+
                     std::string(" pid=")+std::to_string(GetProcessId(ctx.userWgc535Process))+
                     " session="+ctx.sessionId+" normal-SYSTEM-input-preserved=1");
                return true;
            }
#endif
'''
 sv=once(sv,'            bool LaunchNormalStreamer(SessionContext& ctx) {',
    user_launch+'            bool LaunchNormalStreamer(SessionContext& ctx) {',
    "user-only launch/stop methods")
 sv=once(sv,'                SyncChatStateToContext(ctx);\n                return true;\n            }\n\n            bool LaunchSecureStreamer',
 '''                SyncChatStateToContext(ctx);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                LaunchUserWgc535(ctx); // failure simply retains the normal 530 GDI stream
#endif
                return true;
            }

            bool LaunchSecureStreamer''',
    "launch user capture after privileged streamer")
 sv=once(sv,'            void StopNormalStreamer(SessionContext& ctx) {\n',
 '''            void StopNormalStreamer(SessionContext& ctx) {
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                StopUserWgc535(ctx);
#endif
''',"console switch stops only user capture helper")
 sv=once(sv,'                if (ctx->framePumpThread.joinable()) {\n                    ctx->framePumpThread.join();\n                }',
 '''                if (ctx->framePumpThread.joinable()) {
                    ctx->framePumpThread.join();
                }
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                StopUserWgc535(*ctx);
#endif''',"session cleanup user process")
 # Safely overlay user frames only on NORMAL desktop; preserve secure branch.
 # GDI keeps running as an immediate fail-safe. When WGC frames flow at 30fps,
 # the default source frames are drained but not emitted.
 wgc_select=r'''
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    bool gotWgc535=false;
                    I420Frame wgc535Frame;
                    uint64_t wgc535Ts=0;
                    if(ctx.userWgc535Process &&
                        WaitForSingleObject(ctx.userWgc535Process,0)==WAIT_TIMEOUT){
                        while(ctx.userWgc535Shmem.ReadRawI420Frame(tmpFrame,tmpTs)){
                            if(!hi5stream::ValidWgc535I420(
                                tmpFrame.width,tmpFrame.height,
                                tmpFrame.y.size(),tmpFrame.u.size(),tmpFrame.v.size())){
                                LogW("[hi5stream-535] rejected unexpected user frame dimensions");
                                continue;
                            }
                            wgc535Frame=std::move(tmpFrame);
                            wgc535Ts=tmpTs;
                            gotWgc535=true;
                        }
                    }
                    const bool secure535=ctx.uacRequested ||
                         ctx.secureStreamerProcess!=nullptr ||
                         ctx.activeMode==DesktopMode::Secure;
                    if(hi5stream::PreferWgc535(gotWgc535,secure535,
                                              ctx.backstageMode,ctx.displayIndex)){
                        normalFrame=std::move(wgc535Frame);
                        normalTs=wgc535Ts;
                        gotNormal=true;
                        ctx.lastUserWgc535Frame=now;
                    }else if(ctx.lastUserWgc535Frame.time_since_epoch().count()!=0 &&
                             (now-ctx.lastUserWgc535Frame)<std::chrono::milliseconds(220) &&
                             !secure535 && !ctx.backstageMode && ctx.displayIndex==0){
                        // Avoid mixing old/slower GDI frames between real WGC arrivals.
                        gotNormal=false;
                    }
                    if(ctx.userWgc535Process &&
                        WaitForSingleObject(ctx.userWgc535Process,0)==WAIT_OBJECT_0){
                        DWORD exitCode=0;
                        GetExitCodeProcess(ctx.userWgc535Process,&exitCode);
                        LogW("[hi5stream-535] user WGC worker exit="+
                             std::to_string(exitCode)+" fallback=qualified-530-GDI");
                        StopUserWgc535(ctx);
                    }
#endif
'''
 sv=once(sv,'                    if (gotNormal) {\n                        ctx.lastNormalFrameAt = now;\n                    }',
    wgc_select+'                    if (gotNormal) {\n                        ctx.lastNormalFrameAt = now;\n                    }',
    "select WGC frames and seamless GDI fallback")
 old='''                                ctx.sender->setExternalStreamHint(stats.streamMode, stats.targetFps, ctx.backstageMode, stats.secureDesktopActive != 0);'''
 assert sv.count(old)==2,"expected normal and secure external hints"
 sv=sv.replace(old,'''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                                const bool wgcSourceFresh=
                                    ctx.lastUserWgc535Frame.time_since_epoch().count()!=0 &&
                                    (now-ctx.lastUserWgc535Frame)<std::chrono::milliseconds(350) &&
                                    ctx.activeMode==DesktopMode::Normal &&
                                    !ctx.uacRequested && !ctx.backstageMode &&
                                    ctx.displayIndex==0;
                                if(wgcSourceFresh)
                                    ctx.sender->setExternalStreamHint(2,ctx.fps,false,false);
                                else
#endif
                                ctx.sender->setExternalStreamHint(stats.streamMode, stats.targetFps, ctx.backstageMode, stats.secureDesktopActive != 0);''',1)
 # No change to secure stats hint
 assert sv.count(old)==1
 # telemetry source selection each 5s during live.
 log_anchor='''                    if (now >= nextFrameAgeLog) {'''
 telemetry=r'''
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    if(ctx.userWgc535Process && now>=nextWgc535Stats){
                        const bool fresh=ctx.lastUserWgc535Frame.time_since_epoch().count()!=0 &&
                            (now-ctx.lastUserWgc535Frame)<std::chrono::milliseconds(500);
                        LogI("[hi5stream-535] user-source status="+
                             std::string(fresh?"active":"waiting")+
                             " session="+ctx.sessionId+
                             " target_fps="+std::to_string(ctx.fps)+
                             " processed_frames_total="+std::to_string(framesForwarded)+
                             " normal-SYSTEM-input=1 fallback=530-GDI");
                        nextWgc535Stats=now+std::chrono::seconds(5);
                    }
#endif
'''
 sv=once(sv,log_anchor,telemetry+log_anchor,"WGC service frame diagnostics")
 sv=once(sv,'                auto nextMonitorPoll = std::chrono::steady_clock::now() + std::chrono::seconds(1);',
 '''                auto nextMonitorPoll = std::chrono::steady_clock::now() + std::chrono::seconds(1);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                auto nextWgc535Stats=std::chrono::steady_clock::now()+std::chrono::seconds(5);
#endif''',
    "WGC diagnostics scheduler")
 # C++ source remains link-compatible, no altered sender, service UAC or launcher.
 for p,h in before.items():
  if digest(Path(p))!=h:raise RuntimeError("Protected 530 source changed "+p)
 assert 'const bool wgc154Requested=false;' in st
 assert 'LaunchInInteractiveSession(std::string(exe),cmd)' in sv
 assert 'LaunchInElevatedDefaultSession(std::string(exePath), cmdLine)' in sv
 assert 'LaunchOnSecureDesktop(std::string(exePath), cmdLine)' in sv
 assert 'ShouldHoldSecureDesktop(' in sv
 assert 'ctx.sender->sendExternalRawI420(normalFrame, forceKf);' in sv
 assert 'ctx.sender->sendExternalRawI420(secureFrame, forceKf);' in sv
 assert 'userWgc535Process' in sv and 'userWgc535CaptureOnly' in st
 streamer.write_text(st,encoding="utf-8",newline="\n")
 service.write_text(sv,encoding="utf-8",newline="\n")
 print("HI5STREAM_535_USER_CONTEXT_OVERLAY_PASS")
 print("WGC_USER_ONLY=1 SYSTEM_INPUT=UNCHANGED UAC=UNCHANGED WEBRTC=UNCHANGED GDI_FALLBACK=1")
 print("STREAMER_SHA",digest(streamer),"SERVICE_SHA",digest(service))
 for path,h in before.items():print("PROTECTED",Path(path).name,h)

if __name__=="__main__":main()
