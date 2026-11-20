#!/usr/bin/env python3
"""539 Newtest-only WGC/GDI contention A/B. Run AFTER source-matched 538 overlay.
Default OFF, no changes to WebRTC signalling/auth, secure helper, codec, or UAC.
"""
import argparse,hashlib
from pathlib import Path
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def once(s,a,b,label):
    n=s.count(a)
    if n!=1: raise RuntimeError(f"539 anchor {label}: expected 1, found {n}")
    return s.replace(a,b,1)
def main():
    p=argparse.ArgumentParser();p.add_argument("--root",required=True)
    root=Path(p.parse_args().root).resolve()/"src"
    st=root/"streamer_main.cpp"
    sv=root/"platform/windows/windows_service.cpp"
    policy=root/"hi5stream154/gdi_standby539_policy.hpp"
    protected=[root/"webrtc_sender.cpp",root/"webrtc_sender.h",
               root/"ipc/session_launcher.cpp",root/"platform/windows/windows_screen.cpp",
               root/"hi5stream154/wgc154_capture.cpp"]
    unchanged={str(f):sha(f) for f in protected}
    if not policy.is_file():raise RuntimeError("539 policy header absent")
    s=st.read_text(encoding="utf-8-sig")
    v=sv.read_text(encoding="utf-8-sig")
    for key in ("wgc538-newtest.log","wgc537-scale-first","--wgc538-reuse-bgra"):
        if key not in s:raise RuntimeError("539 requires qualified 538 streamer: "+key)
    for key in ("Wgc536ShouldRetry(", "StopUserWgc535(", "LaunchOnSecureDesktop(",
                "HI5_STREAM_538_REUSE_BGRA"):
        if key not in v:raise RuntimeError("539 requires qualified 538 service: "+key)
    if "gdiStandby539Event" in s or "wgc539StandbyEvent" in v:
        raise RuntimeError("539 already applied")
    s=once(s,"        std::string stopEventName;",
           "        std::string stopEventName;\n"
           "#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n"
           "        std::string gdiStandby539Name;\n"
           "#endif","streamer args")
    s=once(s,
           '        if (auto v = GetArgValue(argc, argv, "--stop-event")) a.stopEventName = *v;',
           '        if (auto v = GetArgValue(argc, argv, "--stop-event")) a.stopEventName = *v;\n'
           '#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n'
           '        if (auto v = GetArgValue(argc, argv, "--gdi-standby539")) a.gdiStandby539Name = *v;\n'
           '#endif',
           "streamer parse")
    s=once(s,"        ShmemRing shmem;",
           '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
        HANDLE gdiStandby539Event=nullptr;
        uint64_t gdiStandby539Ticks=0;
        if(!args.gdiStandby539Name.empty() &&
           args.shmemName.rfind("Global\\\\Hi5Stream_",0)==0 &&
           args.shmemName.find("_UAC_")==std::string::npos){
            char host539[MAX_COMPUTERNAME_LENGTH+1]{};
            DWORD len539=sizeof(host539);
            if(GetComputerNameA(host539,&len539) &&
               _stricmp(host539,"DESKTOP-Q9LTF1M")==0)
                gdiStandby539Event=OpenEventA(
                    SYNCHRONIZE,FALSE,args.gdiStandby539Name.c_str());
            if(!gdiStandby539Event)
                LogWarn("[hi5stream-539] GDI standby event unavailable; original GDI stays enabled");
        }
#endif
        ShmemRing shmem;''',"open fail-safe event")
    s=once(s,"            if (stopEvent) CloseHandle(stopEvent);\n            return 1;",
           '''            if (stopEvent) CloseHandle(stopEvent);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
            if(gdiStandby539Event)CloseHandle(gdiStandby539Event);
#endif
            return 1;''',"shmem failure cleanup")
    s=once(s,"            try {\n                if (now >= nextCaptureAt) {",
           '''            try {
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                // USER WGC is producing fresh normal desktop frames. Pause
                // expensive redundant SYSTEM GDI grabs, NOT the input pump.
                // Service resets event within 220 ms of WGC source loss.
                if (gdiStandby539Event && !isSecureHelper && !wgc154 &&
                    currentDisplay==0 && !lastSecureState &&
                    WaitForSingleObject(gdiStandby539Event,0)==WAIT_OBJECT_0) {
                    ++gdiStandby539Ticks;
                    nextCaptureAt=now+std::chrono::milliseconds(10);
                }else
#endif
                if (now >= nextCaptureAt) {''',"never block input, bypass GDI only")
    s=once(s,"                nextStatsAt = currentTime + statsEvery;",
           '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                if(gdiStandby539Event){
                    LogInfo("[hi5stream-539] normal GDI standby ticks_5s="+
                        std::to_string(gdiStandby539Ticks)+
                        " session="+args.sessionId);
                    gdiStandby539Ticks=0;
                }
#endif
                nextStatsAt = currentTime + statsEvery;''',"standby telemetry")
    s=once(s,"        if (stopEvent) {\n            CloseHandle(stopEvent);\n        }",
           '''        if (stopEvent) {
            CloseHandle(stopEvent);
        }
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
        if(gdiStandby539Event)CloseHandle(gdiStandby539Event);
#endif''',"normal exit cleanup")
    v=once(v,'#include "hi5stream154/wgc536_recovery_policy.hpp"',
           '#include "hi5stream154/wgc536_recovery_policy.hpp"\n'
           '#include "hi5stream154/gdi_standby539_policy.hpp"',
           "service policy include")
    v=once(v,"            std::string normalStopEventName;",
           '''            std::string normalStopEventName;
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
            std::string wgc539StandbyName;
            HANDLE wgc539StandbyEvent=nullptr;
            bool wgc539StandbyActive=false;
#endif''',"session state")
    v=once(v,"                ResetEvent(ctx.normalStopEvent);\n\n                std::string cmdLine =\n                    \"--mode streamer\"",
           '''                ResetEvent(ctx.normalStopEvent);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                if(ctx.wgc539StandbyEvent){
                    ResetEvent(ctx.wgc539StandbyEvent);
                    ctx.wgc539StandbyActive=false;
                }
#endif

                std::string cmdLine =
                    "--mode streamer"''',"reset on normal helper relaunch")
    v=once(v,"                LogI(\"launch normal streamer [NORMAL_SHMEM_EXPECTED_NO_UAC] session=\"",
           '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                if(ctx.wgc539StandbyEvent)
                    cmdLine+=" --gdi-standby539 "+ctx.wgc539StandbyName;
#endif
                LogI("launch normal streamer [NORMAL_SHMEM_EXPECTED_NO_UAC] session="''',
           "normal helper only receives standby signal")
    v=once(v,"            void StopNormalStreamer(SessionContext& ctx) {\n#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n                StopUserWgc535(ctx);\n#endif\n                if (ctx.normalStopEvent) {",
           '''            void StopNormalStreamer(SessionContext& ctx) {
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                StopUserWgc535(ctx);
                if(ctx.wgc539StandbyEvent){
                    ResetEvent(ctx.wgc539StandbyEvent);
                    ctx.wgc539StandbyActive=false;
                }
#endif
                if (ctx.normalStopEvent) {''',"reset before normal helper stop")
    v=once(v,"                ctx->chatPipeServer = std::make_unique<NamedPipeServer>();",
           '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                // Must independently opt in WGC and standby. Same Newtest
                // hostname/policy guard, default OFF. Never install on UAC.
                char standby539[8]{},wgc539[8]{};
                char name539[MAX_COMPUTERNAME_LENGTH+1]{};
                DWORD n539=sizeof(name539);
                const bool allow539=
                    GetEnvironmentVariableA("HI5_STREAM_539_GDI_STANDBY",
                        standby539,sizeof(standby539))==1 &&
                    standby539[0]=='1' &&
                    GetEnvironmentVariableA("HI5_STREAM_V154_WGC_CANARY",
                        wgc539,sizeof(wgc539))==1 && wgc539[0]=='1' &&
                    GetComputerNameA(name539,&n539) &&
                    _stricmp(name539,"DESKTOP-Q9LTF1M")==0 &&
                    !ctx->backstageMode && ctx->displayIndex==0;
                if(allow539){
                    ctx->wgc539StandbyName="Global\\\\Hi5GdiStandby539_"+prefix;
                    ctx->wgc539StandbyEvent=CreateEventA(
                        nullptr,TRUE,FALSE,ctx->wgc539StandbyName.c_str());
                    if(!ctx->wgc539StandbyEvent){
                        LogW("[hi5stream-539] standby event creation failed; GDI fallback stays enabled");
                    }
                }
#endif
                ctx->chatPipeServer = std::make_unique<NamedPipeServer>();''',"create per-session opt-in event")
    v=once(v,"#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n                    if(gotNormal && !gotWgc535 && !secure535)",
           '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    if(ctx.wgc539StandbyEvent){
                        const int64_t age539=
                            ctx.lastUserWgc535Frame.time_since_epoch().count()!=0
                              ? std::chrono::duration_cast<std::chrono::milliseconds>(
                                   now-ctx.lastUserWgc535Frame).count() : -1;
                        const bool standby539=hi5stream::ShouldStandbyGdi539(
                            true,true,ctx.userWgc535Process!=nullptr &&
                                WaitForSingleObject(ctx.userWgc535Process,0)==WAIT_TIMEOUT,
                            ctx.activeMode==DesktopMode::Normal && !secure535,
                            ctx.uacRequested,ctx.backstageMode,
                            ctx.consoleSwitchInProgress,ctx.displayIndex,age539);
                        if(standby539 != ctx.wgc539StandbyActive){
                            if(standby539)SetEvent(ctx.wgc539StandbyEvent);
                            else ResetEvent(ctx.wgc539StandbyEvent);
                            ctx.wgc539StandbyActive=standby539;
                            LogI("[hi5stream-539] normal GDI standby "+
                                 std::string(standby539?"ON":"OFF")+
                                 " age_ms="+std::to_string(age539)+
                                 " session="+ctx.sessionId);
                        }
                    }
                    if(gotNormal && !gotWgc535 && !secure535)''',"fresh WGC service decision")
    v=once(v,"                    CloseHandle(ctx->normalStopEvent);\n                    ctx->secureStopEvent = nullptr;",
           '''                    CloseHandle(ctx->normalStopEvent);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    if(ctx->wgc539StandbyEvent){
                        ResetEvent(ctx->wgc539StandbyEvent);
                        CloseHandle(ctx->wgc539StandbyEvent);
                        ctx->wgc539StandbyEvent=nullptr;
                    }
#endif
                    ctx->secureStopEvent = nullptr;''',"failed launch cleanup")
    v=once(v,"                if (ctx->normalStopEvent) {\n                    CloseHandle(ctx->normalStopEvent);\n                    ctx->normalStopEvent = nullptr;\n                }",
           '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                if(ctx->wgc539StandbyEvent){
                    ResetEvent(ctx->wgc539StandbyEvent);
                    CloseHandle(ctx->wgc539StandbyEvent);
                    ctx->wgc539StandbyEvent=nullptr;
                }
#endif
                if (ctx->normalStopEvent) {
                    CloseHandle(ctx->normalStopEvent);
                    ctx->normalStopEvent = nullptr;
                }''',"successful session cleanup")
    for f,contents in ((st,s),(sv,v)): f.write_text(contents,encoding="utf-8",newline="\n")
    for f in protected:
        if sha(f)!=unchanged[str(f)]:raise RuntimeError("Protected sender/UAC/capture changed: "+str(f))
    for needle in ("ctx.sender->sendExternalRawI420(secureFrame, forceKf);",
                   "LaunchOnSecureDesktop(std::string(exePath), cmdLine)",
                   "Wgc536ShouldRetry("):
        if needle not in v:raise RuntimeError("protected original missing: "+needle)
    print("HI5STREAM539_PATCH_PASS: Newtest only, opt-in event, input/UAC/sender unchanged")
    print("SERVICE_SHA",sha(sv),"STREAM_SHA",sha(st))
if __name__=="__main__":main()
