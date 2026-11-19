#!/usr/bin/env python3
"""Hi5Stream 1.0.536: auto-recover signed-in user WGC; lift VP8's 20FPS ceiling
only while verified WGC source is actively feeding normal desktop.
Applies AFTER pinned qualified 530 -> 534 -> 535 overlays. Default-off;
fails closed on any source anchor mismatch.
"""
import argparse,hashlib
from pathlib import Path

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def once(txt,old,new,stage):
 n=txt.count(old)
 if n!=1:raise RuntimeError(f"536 source anchor [{stage}] expected once, got {n}")
 return txt.replace(old,new,1)

def main():
 a=argparse.ArgumentParser()
 a.add_argument("--root",required=True)
 args=a.parse_args()
 root=Path(args.root).resolve();src=root/"src"
 service=src/"platform/windows/windows_service.cpp"
 sender=src/"webrtc_sender.cpp"
 header=src/"webrtc_sender.h"
 protected=[src/"platform/windows/windows_screen.cpp",
            src/"ipc/session_launcher.cpp",src/"streamer_main.cpp"]
 hashes={str(p):sha(p) for p in protected}
 policy=src/"hi5stream154/wgc536_recovery_policy.hpp"
 if not policy.is_file():raise RuntimeError("Missing 536 testable source policy")
 sv=service.read_text(encoding="utf-8-sig")
 sc=sender.read_text(encoding="utf-8-sig")
 hd=header.read_text(encoding="utf-8-sig")
 if not all(x in sv for x in (
   "void StopUserWgc535(", "bool LaunchUserWgc535(",
   "ctx.userWgc535Process", "ctx.sender->sendExternalRawI420(normalFrame, forceKf);",
   "ctx.sender->sendExternalRawI420(secureFrame, forceKf);",
   "LaunchInElevatedDefaultSession(std::string(exePath), cmdLine)",
   "LaunchOnSecureDesktop(std::string(exePath), cmdLine)")):
  raise RuntimeError("535 user capture and qualified UAC service not reconstructed")
 if not all(x in sc for x in ("buildVp8RuntimeProfile(", "HI5_VP8_MOTION_FPS",
    "m_externalHintFps", "m_externalConfiguredFps")):
  raise RuntimeError("Qualified VP8 sender unexpectedly different")
 if "Wgc536" in sc or "Wgc536" in sv:raise RuntimeError("536 already patched")

 sv=once(sv,
 '#include "hi5stream154/user_capture_policy535.hpp"',
 '#include "hi5stream154/user_capture_policy535.hpp"\n'
 '#include "hi5stream154/wgc536_recovery_policy.hpp"',
 "536 recovery policy include")
 sc=once(sc,'#include "webrtc_sender.h"',
 '#include "webrtc_sender.h"\n'
 '#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n'
 '#include "hi5stream154/wgc536_recovery_policy.hpp"\n'
 '#endif',
 "536 VP8 FPS guard include")
 hd=once(hd,
 '    void setExternalStreamHint(int streamMode, int targetFps, bool backstageMode, bool secureDesktop);',
 '''    void setExternalStreamHint(int streamMode, int targetFps, bool backstageMode,
                               bool secureDesktop, bool fromHealthyWgc536 = false);''',
 "nonbreaking optional WGC signal")
 hd=once(hd,'    std::atomic<int> m_externalHintFps{ 0 };',
 '''    std::atomic<int> m_externalHintFps{ 0 };
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
    std::atomic<bool> m_externalHintWgc536{ false }; // Never true for legacy/GDI/UAC
#endif''',
 "atomic WGC health hint")
 sc=once(sc,
 'void WebRtcSender::setExternalStreamHint(int streamMode, int targetFps, bool backstageMode, bool secureDesktop) {',
 '''void WebRtcSender::setExternalStreamHint(int streamMode, int targetFps, bool backstageMode,
    bool secureDesktop, bool fromHealthyWgc536) {
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
    // The service sets this TRUE only for fresh user-owned WGC on the normal desktop.
    m_externalHintWgc536 = fromHealthyWgc536 && !backstageMode && !secureDesktop;
#else
    (void)fromHealthyWgc536;
#endif''',
 "sender WGC-only healthy hint")
 profile=r'''
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
    // Default VP8 motion=20fps. Only override it when a real WGC frame has
    // arrived recently; all other codecs, GDI fallback and secure UAC retain
    // their qualified profiles. No forced FPS on a motionless screen.
    if(m_videoCodec == VideoCodec::VP8 &&
       m_externalHintWgc536.load() &&
       !m_externalHintBackstage.load() &&
       !m_externalHintSecure.load()){
        const int desired=std::min(std::max(1,m_fps),
                                   std::max(1,m_externalHintFps.load()));
        const int selected=hi5stream::Wgc536Vp8Fps(
            true,false,false,effectiveMode,desired,profile.fps);
        if(selected != profile.fps){
            profile.fps=selected;
            profile.name="software-vp8-wgc536-motion";
            // Low CPU without changing quantizer or bitrate policy.
            if(selected >= 45)profile.cpuUsed=std::max(profile.cpuUsed,12);
        }
    }
#endif
'''
 sc=once(sc,
 '''    const bool sizeChanged = frame.width != m_externalEncoderWidth || frame.height != m_externalEncoderHeight;''',
 profile+'''    const bool sizeChanged = frame.width != m_externalEncoderWidth || frame.height != m_externalEncoderHeight;''',
 "WGC-only VP8 full target")
 sv=once(sv,'                auto nextWgc535Stats=std::chrono::steady_clock::now()+std::chrono::seconds(5);',
 '''                auto nextWgc535Stats=std::chrono::steady_clock::now()+std::chrono::seconds(5);
                auto wgc536StatsAt=std::chrono::steady_clock::now();
                auto wgc536NormalSince=std::chrono::steady_clock::time_point{};
                auto wgc536LastAttempt=std::chrono::steady_clock::now();
                auto wgc536GoodSince=std::chrono::steady_clock::time_point{};
                unsigned wgc536Failures=0;
                uint64_t wgc536WindowUser=0,wgc536WindowGdi=0;
                uint64_t wgc536ForwardedAtLast=0;
                const bool wgc536OptedIn=[](){
                    char flag[8]{};
                    return GetEnvironmentVariableA("HI5_STREAM_V154_WGC_CANARY",
                        flag,static_cast<DWORD>(sizeof(flag)))==1 && flag[0]=='1';
                }();''',
 "recovery state and 5s measurement counters")
 # WGC lifecycle run after the existing secure-desktop poll, before GDI/WGC reads.
 recovery=r'''
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    // Re-arm the user capture helper only after stable NORMAL
                    // desktop conditions have returned. Never attempt it during
                    // UAC, Winlogon, backstage or monitor/session transitions.
                    const bool normal536Fresh=ctx.lastNormalFrameAt.time_since_epoch().count()!=0 &&
                        (now-ctx.lastNormalFrameAt)<std::chrono::milliseconds(850);
                    const bool ready536=hi5stream::Wgc536NormalReady(
                        wgc536OptedIn,ctx.normalStreamerProcess!=nullptr,
                        ctx.uacRequested,ctx.secureStreamerProcess!=nullptr,
                        ctx.activeMode==DesktopMode::Normal,
                        ctx.backstageMode,ctx.consoleSwitchInProgress,
                        ActiveConsoleSessionId()==ctx.activeConsoleSessionId,
                        ctx.displayIndex,normal536Fresh);
                    if(!ready536){
                        wgc536NormalSince={};
                        wgc536GoodSince={};
                    }else if(wgc536NormalSince.time_since_epoch().count()==0){
                        wgc536NormalSince=now;
                    }
                    if(!ctx.userWgc535Process && ready536 &&
                       wgc536NormalSince.time_since_epoch().count()!=0){
                        const auto stableMs=std::chrono::duration_cast<
                            std::chrono::milliseconds>(now-wgc536NormalSince).count();
                        const auto sinceMs=std::chrono::duration_cast<
                            std::chrono::milliseconds>(now-wgc536LastAttempt).count();
                        if(hi5stream::Wgc536ShouldRetry(true,stableMs,sinceMs,
                                                       wgc536Failures)){
                            const unsigned failure=++wgc536Failures;
                            wgc536LastAttempt=now;
                            const bool launched=LaunchUserWgc535(ctx);
                            LogI("[hi5stream-536] user WGC recovery"+
                                 std::string(launched?" launched":" unavailable")+
                                 " session="+ctx.sessionId+
                                 " attempt="+std::to_string(failure)+
                                 " next_backoff_ms="+std::to_string(
                                    hi5stream::Wgc536RetryDelayMs(wgc536Failures))+
                                 " normal_stable_ms="+std::to_string(stableMs));
                        }
                    }
#endif
'''
 sv=once(sv,'                    I420Frame normalFrame;\n',
 recovery+'                    I420Frame normalFrame;\n',
 "normal-only bounded user WGC recovery")
 # Place WGC source counter within valid user frame selection, not legacy.
 sv=once(sv,
 '''                        ctx.lastUserWgc535Frame=now;''',
 '''                        ctx.lastUserWgc535Frame=now;
                        ++wgc536WindowUser;
                        if(wgc536GoodSince.time_since_epoch().count()==0)
                            wgc536GoodSince=now;
                        else if(now-wgc536GoodSince>=std::chrono::seconds(10))
                            wgc536Failures=0; // sustained healthy capture restores short retry backoff''',
 "valid WGC source frame counter")
 sv=once(sv,
 '''                    if (gotNormal) {
                        ctx.lastNormalFrameAt = now;
                    }''',
 '''#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    if(gotNormal && !gotWgc535 && !secure535)
                        ++wgc536WindowGdi;
#endif
                    if (gotNormal) {
                        ctx.lastNormalFrameAt = now;
                    }''',
 "GDI fallback frame counter")
 sv=once(sv,
 '''                                    ctx.sender->setExternalStreamHint(2,ctx.fps,false,false);''',
 '''                                    ctx.sender->setExternalStreamHint(2,ctx.fps,false,false,true);''',
 "fresh WGC hint gets 30/60 VP8")
 # Fast fail to GDI also resets hint in downstream old 4-arg call (default=false)
 # and source on UAC remains secure in separate untouched send path.
 sv=once(sv,
 '''                        nextWgc535Stats=now+std::chrono::seconds(5);''',
 '''                        // Five-second source measurements: distinct from
                        // encoder FPS and Safari-decoded FPS.
                        const double seconds=std::max(0.001,
                            std::chrono::duration<double>(now-wgc536StatsAt).count());
                        const uint64_t forwardedWindow=framesForwarded-wgc536ForwardedAtLast;
                        LogI("[hi5stream-536] fps session="+ctx.sessionId+
                             " wgc_source_fps="+std::to_string(
                                 static_cast<double>(wgc536WindowUser)/seconds)+
                             " gdi_fallback_fps="+std::to_string(
                                 static_cast<double>(wgc536WindowGdi)/seconds)+
                             " forwarded_fps="+std::to_string(
                                 static_cast<double>(forwardedWindow)/seconds)+
                             " requested_fps="+std::to_string(ctx.fps)+
                             " active_desktop="+std::string(
                                 ctx.activeMode==DesktopMode::Normal?"normal":"secure")+
                             " user_helper="+std::to_string(ctx.userWgc535Process?1:0)+
                             " recovery_attempts="+std::to_string(wgc536Failures));
                        wgc536WindowUser=wgc536WindowGdi=0;
                        wgc536ForwardedAtLast=framesForwarded;
                        wgc536StatsAt=now;
                        nextWgc535Stats=now+std::chrono::seconds(5);''',
 "5s WGC/GDI/forwarder diagnostics")
 # Original C++ sender auth, session launch and UAC secure files are guarded.
 for path,h in hashes.items():
  if sha(Path(path))!=h:raise RuntimeError("Protected streamer/launcher/capture altered "+path)
 assert 'ctx.sender->sendExternalRawI420(normalFrame, forceKf);' in sv
 assert 'ctx.sender->sendExternalRawI420(secureFrame, forceKf);' in sv
 assert 'LaunchOnSecureDesktop(std::string(exePath), cmdLine)' in sv
 assert 'LaunchInElevatedDefaultSession(std::string(exePath), cmdLine)' in sv
 assert 'Wgc536ShouldRetry(' in sv
 assert 'fromHealthyWgc536' in sc and 'm_externalHintWgc536' in hd
 service.write_text(sv,encoding="utf-8",newline="\n")
 sender.write_text(sc,encoding="utf-8",newline="\n")
 header.write_text(hd,encoding="utf-8",newline="\n")
 print("HI5STREAM536_PATCH_OK qualified_530_service_legacy=1 WGC_user_recovery=1 VP8_30_60_only_when_WGC_healthy=1")
 print("NEW_SOURCE_SHA256",sha(service),sha(sender),sha(header))
 for k,v in hashes.items():print("PROTECTED",Path(k).name,v)

if __name__=="__main__":
 main()
