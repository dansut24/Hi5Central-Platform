#!/usr/bin/env python3
"""Overlay WGC v0.15.4 on the exact source reconstructed by the qualified 530 workflow.
Never apply to the stale Git checkout; fail closed on missing 530 stage markers.
Preserve 530 WebRTC, authentication, service, secure desktop and screen-capture files.
"""
import argparse
import hashlib
from pathlib import Path

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def once(s,old,new,label):
    n=s.count(old)
    if n!=1:
        raise RuntimeError(f"HI5STREAM 534 {label}: expected one anchor, found {n}")
    return s.replace(old,new,1)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root",required=True)
    p.add_argument("--reference-cmake",required=True)
    args=p.parse_args()
    r=Path(args.root).resolve(); src=r/"src"
    protected=[src/"webrtc_sender.cpp",src/"webrtc_sender.h",
      src/"platform/windows/windows_service.cpp",
      src/"platform/windows/windows_screen.cpp",
      src/"ipc/session_launcher.cpp",src/"main.cpp"]
    hashes={str(f):sha(f) for f in protected}
    sender=(src/"webrtc_sender.cpp").read_text(encoding="utf-8-sig")
    service=(src/"platform/windows/windows_service.cpp").read_text(encoding="utf-8-sig")
    capture=(src/"platform/windows/windows_screen.cpp").read_text(encoding="utf-8-sig")
    stream_path=src/"streamer_main.cpp"
    stream=stream_path.read_text(encoding="utf-8-sig")
    if not all(x in sender for x in ("RtcpNackResponder","PliHandler","HI5_STREAM_FULL_RATE_CANARY")):
        raise RuntimeError("Qualified 530 WebRTC sender not reconstructed")
    if not all(x in service for x in ("ShouldHoldSecureDesktop","HI5_STREAM_FULL_RATE_CANARY","lastSecureLaunchAttempt")):
        raise RuntimeError("Qualified 530 service/UAC source not reconstructed")
    if not all(x in capture for x in ("enableGdiFallback(","HI5_GDI_DIRECT_1080_CANARY","GdiDirectNormalUserDesktop")):
        raise RuntimeError("Qualified 530 GDI/DXGI capture not reconstructed")
    if not all(x in stream for x in ("HI5_GDI_DIRECT_1080_CANARY","HI5_STREAM_FULL_RATE_CANARY","actual_capture_fps=")):
        raise RuntimeError("Qualified 530 streaming/pacing not reconstructed")
    for f in ("wgc154_capture.cpp","wgc154_capture.h","canary_policy.hpp","frame_pacer.hpp","winrt_interop_minimal.hpp"):
        if not (src/"hi5stream154"/f).is_file():
            raise RuntimeError("Missing pinned canary component "+f)
    cmake_path=r/"CMakeLists.txt";cmake=cmake_path.read_text(encoding="utf-8-sig")
    ref=Path(args.reference_cmake).read_text(encoding="utf-8-sig")
    first=ref.index("# OFF by default in every existing agent release.")
    last=ref.index("target_include_directories(native_vp8_stream BEFORE PRIVATE",first)
    block=ref[first:last]
    # C++/WinRT supports C++17; matching v1.0.530's coroutine ABI is
    # essential. Compiling only the WGC object as C++20 produced MSVC
    # LNK2038 (_COROUTINE_ABI=2 versus 1 in main.obj) on 2026-11-19.
    # Do NOT suppress linker ABI mismatches or switch the working sender
    # to C++20. There are no co_await/co_return functions in this adapter.
    if block.count('COMPILE_OPTIONS "/std:c++20"')!=1 or block.count('COMPILE_OPTIONS "-std=c++20"')!=1:
        raise RuntimeError("Unexpected WinRT adapter language flags")
    block=block.replace('COMPILE_OPTIONS "/std:c++20"', 'COMPILE_OPTIONS "/std:c++17"')
    block=block.replace('COMPILE_OPTIONS "-std=c++20"', 'COMPILE_OPTIONS "-std=c++17"')
    block=block.replace('Only the separately compiled WinRT adapter requires C++20.',
                        'WinRT adapter also uses C++17 to preserve the 530 coroutine ABI.')
    if 'COMPILE_OPTIONS "/std:c++17"' not in block or '/std:c++20' in block:
        raise RuntimeError("WGC/agent coroutine ABI setting inconsistent")
    if "HI5_ENABLE_WGC154_CANARY" in cmake:
        raise RuntimeError("Unexpected existing WGC compilation flag")
    cmake=once(cmake,"hi5_use_static_msvc_runtime(native_vp8_stream)",
        "hi5_use_static_msvc_runtime(native_vp8_stream)\n\n"+block,
        "CMake C++17 ABI-compatible adapter")
    stream=once(stream,'#include "frame_source.h"',
        '#include "frame_source.h"\n#ifdef HI5_ENABLE_WGC154_CANARY_BUILD\n'
        '#include "hi5stream154/canary_policy.hpp"\n'
        '#include "hi5stream154/frame_pacer.hpp"\n'
        '#include "hi5stream154/wgc154_capture.h"\n'
        '#include <memory>\n#include <cctype>\n#endif',
        "opt-in WGC headers")

    setup=r"""
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
        // Environment inherited from the Windows SYSTEM service, default OFF.
        // The policy also pins hostname, monitor, FPS and normal desktop.
        const bool wgc154Requested=ReadEnvInt("HI5_STREAM_V154_WGC_CANARY",0,0,1)==1;
        char name[MAX_COMPUTERNAME_LENGTH+1]{};
        DWORD nameLength=sizeof(name);
        std::string host;
        if(GetComputerNameA(name,&nameLength)){
            host.assign(name,nameLength);
            for(auto& c:host)c=static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        }
        const auto eligibility=hi5::EvaluateWgc154Canary(
            wgc154Requested,host,isSecureHelper,IsSecureDesktopActive(),
            currentDisplay,requestedMaxFps);
        std::unique_ptr<hi5::Wgc154Capture> wgc154;
        std::optional<hi5stream::AbsoluteVideoPacer> pacer154;
        hi5::Wgc154Metrics metrics154{};
        uint64_t videoFrames154=0, fallbacks154=0;
        if(wgc154Requested)
            LogInfo("[hi5stream-534] requested=1 host="+host+
                    " eligibility="+eligibility.reason+" session="+args.sessionId);
        if(eligibility.enabled){
            auto candidate=std::make_unique<hi5::Wgc154Capture>();
            std::string reason;
            if(candidate->start(reason)){
                wgc154=std::move(candidate);
                pacer154.emplace(static_cast<unsigned>(requestedMaxFps),
                                 std::chrono::steady_clock::now());
                LogInfo("[hi5stream-534] WGC active; original 530 VP8/WebRTC preserved");
            }else{
                ++fallbacks154;
                LogWarn("[hi5stream-534] WGC unavailable; 530 GDI fallback reason="+reason);
            }
        }
        auto disable154=[&](const std::string& reason){
            if(!wgc154)return;
            wgc154->stop();wgc154.reset();pacer154.reset();
            ++fallbacks154;
            LogWarn("[hi5stream-534] fallback=530-gdi reason="+reason);
        };
#endif
"""
    stream=once(stream,'        const int requestedMaxFps = std::max(1, args.fps);',
        '        const int requestedMaxFps = std::max(1, args.fps);\n'+setup,
        "runtime opt-in and Lenovo allowlist")
    transition=r"""
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
            if(wgc154 && (currentDisplay!=0 || IsSecureDesktopActive()))
                disable154(currentDisplay!=0 ? "monitor-switch" : "secure-desktop");
#endif
"""
    stream=once(stream,'            try {\n                if (now >= nextCaptureAt) {',
        transition+'            try {\n                if (now >= nextCaptureAt) {',
        "secure desktop WGC hard stop")
    cap=r"""#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    FrameCaptureResult captured;
                    if(wgc154){
                        std::string err;
                        if(!wgc154->takeLatest(captured,metrics154,err,25)){
                            disable154(err);
                            captured=source.nextFrameEx();
                        }
                    }else{
                        captured=source.nextFrameEx();
                    }
#else
                    FrameCaptureResult captured = source.nextFrameEx();
#endif"""
    stream=once(stream,'                    FrameCaptureResult captured = source.nextFrameEx();',
        cap,"WGC latest frame or untouched qualified GDI")
    old="""                    const int targetFps = recentInput ? motionFps : (recentMotion ? activeFps : idleFps);
                    lastTargetFps = targetFps;
                    lastStreamMode = recentInput ? 2 : (recentMotion ? 1 : 0);
                    const auto frameInterval = std::chrono::milliseconds(1000 / std::max(1, targetFps));
                    nextCaptureAt = now + frameInterval;"""
    new=r"""                    int targetFps = recentInput ? motionFps : (recentMotion ? activeFps : idleFps);
                    lastStreamMode = recentInput ? 2 : (recentMotion ? 1 : 0);
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                    if(wgc154 && pacer154){
                        targetFps=requestedMaxFps;
                        lastStreamMode=2; // 530 software VP8 motion profile
                        if(captured.hasFrame){
                            pacer154->frame_selected(std::chrono::steady_clock::now());
                            ++videoFrames154;
                        }
                        nextCaptureAt=pacer154->deadline();
                    }else
#endif
                    {
                        const auto frameInterval = std::chrono::milliseconds(1000 / std::max(1, targetFps));
                        nextCaptureAt = now + frameInterval;
                    }
                    lastTargetFps=targetFps;"""
    stream=once(stream,old,new,"absolute 15/30/45/60 canary, identical 530 off-path")
    stats=r"""
#ifdef HI5_ENABLE_WGC154_CANARY_BUILD
                if(wgc154Requested){
                    LogInfo("[hi5stream-534] stats session="+args.sessionId+
                        " active="+std::to_string(wgc154?1:0)+
                        " frames="+std::to_string(videoFrames154)+
                        " arrivals="+std::to_string(metrics154.sourceFrames)+
                        " replaced="+std::to_string(metrics154.oldFramesReplaced)+
                        " empty="+std::to_string(metrics154.emptyPolls)+
                        " missed_slots="+std::to_string(pacer154?pacer154->missed_slots():0)+
                        " conversion_ms="+std::to_string(metrics154.conversionMs)+
                        " scale_ms="+std::to_string(metrics154.scaleMs)+
                        " fallbacks="+std::to_string(fallbacks154));
                    videoFrames154=0;
                }
#endif
"""
    stream=once(stream,'                LogInfo("[streamer] low-cpu stats session=" + args.sessionId +',
        stats+'                LogInfo("[streamer] low-cpu stats session=" + args.sessionId +',
        "capture and absolute pacing telemetry")
    for f in protected:
        if sha(f)!=hashes[str(f)]:
            raise RuntimeError("UNSAFE: protected 530 source modified: "+str(f))
    assert "HI5_STREAM_FULL_RATE_CANARY" in stream and "[gdi-direct]" in stream
    assert "HI5_ENABLE_WGC154_CANARY" in cmake
    assert 'COMPILE_OPTIONS "/std:c++17"' in cmake and 'COMPILE_OPTIONS "/std:c++20"' not in cmake
    cmake_path.write_text(cmake,encoding="utf-8",newline="\n")
    stream_path.write_text(stream,encoding="utf-8",newline="\n")
    for f in protected:
        print("QUALIFIED_530_UNCHANGED",f.name,hashes[str(f)])
    print("HI5STREAM_534_PATCH_OK default_off=1 protected_webrtc=1 protected_uac=1 cxx17_legacy=1")
    print("PATCHED",sha(cmake_path),sha(stream_path))
if __name__=="__main__":
    main()
