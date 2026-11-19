#!/usr/bin/env python3
"""Apply experimental 1.0.537 BGRA scale-first to verified 536 source tree."""
import argparse,hashlib
from pathlib import Path
def hashfile(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def swap(s,a,b,label):
 c=s.count(a)
 if c!=1:raise RuntimeError(f"537 source guard {label}: matches={c}")
 return s.replace(a,b,1)
def main():
 ap=argparse.ArgumentParser();ap.add_argument("--root",required=True)
 root=Path(ap.parse_args().root)/"src"
 cpp=root/"hi5stream154/wgc154_capture.cpp"
 header=root/"hi5stream154/wgc154_capture.h"
 stream=root/"streamer_main.cpp"
 service=root/"platform/windows/windows_service.cpp"
 policy=root/"hi5stream154/scale_first537_policy.hpp"
 assert policy.is_file()
 protect=[root/"webrtc_sender.cpp",root/"webrtc_sender.h",root/"platform/windows/windows_screen.cpp",root/"ipc/session_launcher.cpp"]
 signatures={str(p):hashfile(p) for p in protect}
 c=cpp.read_text(encoding="utf-8-sig");h=header.read_text(encoding="utf-8-sig")
 s=stream.read_text(encoding="utf-8-sig");v=service.read_text(encoding="utf-8-sig")
 for a in ("libyuv::ARGBToI420","libyuv::I420Scale","metrics.conversionMs="):
  if a not in c:raise RuntimeError("Expected 536 capture source missing: "+a)
 for a in ("userWgc535CaptureOnly","Wgc154Capture capture;","frames_5s="):
  if a not in s:raise RuntimeError("Expected 536 USER helper missing: "+a)
 for a in ("Wgc536ShouldRetry(","LaunchInInteractiveSession(std::string(exe),cmd)","LaunchOnSecureDesktop(std::string(exePath), cmdLine)"):
  if a not in v:raise RuntimeError("Expected 536 normal/UAC service missing: "+a)
 if "scaleFirst537" in c or "HI5_STREAM_537_SCALE_FIRST" in v:raise RuntimeError("537 overlay already applied")
 h=swap(h,"    bool start(std::string& error);","    bool start(std::string& error);\n    void setScaleFirst537(bool enabled) noexcept;","header setter")
 h=swap(h,"    double readbackMs=0,conversionMs=0,scaleMs=0,frameAgeMs=0;","    double readbackMs=0,conversionMs=0,scaleMs=0,frameAgeMs=0;\n    bool scaleFirst537Active=false;\n    uint64_t scaleFirst537Fallbacks=0;","metrics")
 c=swap(c,"#include <libyuv/scale.h>","#include <libyuv/scale.h>\n#include <libyuv/scale_argb.h>\n#include \"scale_first537_policy.hpp\"","includes")
 c=swap(c,"    std::vector<uint8_t> nativeI420;","    std::vector<uint8_t> nativeI420;\n    std::vector<uint8_t> scaledBgra537;\n    bool scaleFirst537=false;\n    uint64_t scaleFirst537Fallbacks=0;","capture state")
 c=swap(c,"Wgc154Capture::~Wgc154Capture(){stop();}","Wgc154Capture::~Wgc154Capture(){stop();}\nvoid Wgc154Capture::setScaleFirst537(bool enabled) noexcept {\n    if(impl_ && !impl_->running)impl_->scaleFirst537=enabled;\n}","setter impl")
 begin="    const int w=static_cast<int>(input.width);\n    const int h=static_cast<int>(input.height);\n    const size_t yLength=size_t(w)*h;"
 end="    const auto completed=Clock::now();"
 i=c.find(begin);j=c.find(end,i)
 if i<0 or j<0 or c.count(begin)!=1:raise RuntimeError("536 exact pixel conversion anchors missing")
 baseline=c[i:j+len(end)]
 if baseline.count("libyuv::ARGBToI420")!=1 or baseline.count("libyuv::I420Scale")!=1:raise RuntimeError("536 baseline converter mismatched")
 legacy=baseline.replace(end,end+'''
    conversionMs537=std::chrono::duration<double,std::milli>(converted-started).count();
    scaleMs537=std::chrono::duration<double,std::milli>(completed-converted).count();''')
 new=r'''    double conversionMs537=0.0,scaleMs537=0.0;
    bool usedScaleFirst537=false;
    const int w537=static_cast<int>(input.width);
    const int h537=static_cast<int>(input.height);
    if(impl_->scaleFirst537 &&
       hi5stream::IsValidScaleFirst537Stride(
           w537,h537,input.stride,Impl::outputWidth,Impl::outputHeight)){
        const int dw=Impl::outputWidth,dh=Impl::outputHeight;
        impl_->scaledBgra537.resize(static_cast<size_t>(dw)*dh*4);
        int rc=libyuv::ARGBScale(input.bgra.data(),input.stride,w537,h537,
            impl_->scaledBgra537.data(),dw*4,dw,dh,libyuv::kFilterBilinear);
        const auto scaledAt=Clock::now();
        if(rc==0){
            auto& out=result.frame;
            out.width=dw;out.height=dh;
            const size_t yLen=static_cast<size_t>(dw)*dh;
            const size_t uvLen=static_cast<size_t>(dw/2)*(dh/2);
            out.y.resize(yLen);out.u.resize(uvLen);out.v.resize(uvLen);
            rc=libyuv::ARGBToI420(impl_->scaledBgra537.data(),dw*4,
                out.y.data(),dw,out.u.data(),dw/2,out.v.data(),dw/2,dw,dh);
            const auto convertedAt=Clock::now();
            if(rc==0){
                scaleMs537=std::chrono::duration<double,std::milli>(
                    scaledAt-started).count();
                conversionMs537=std::chrono::duration<double,std::milli>(
                    convertedAt-scaledAt).count();
                usedScaleFirst537=true;
            }
        }
        if(!usedScaleFirst537){
            impl_->scaleFirst537=false; // immediate exact-536 fallback
            ++impl_->scaleFirst537Fallbacks;
        }
    }
    if(!usedScaleFirst537){
'''
 c=c[:i]+new+legacy+"\n    }\n    const auto completed537=Clock::now();"+c[j+len(end):]
 c=swap(c,'''    metrics.conversionMs=std::chrono::duration<double,std::milli>(
        converted-started).count();
    metrics.scaleMs=std::chrono::duration<double,std::milli>(
        completed-converted).count();''','''    metrics.conversionMs=conversionMs537;
    metrics.scaleMs=scaleMs537;
    metrics.scaleFirst537Active=usedScaleFirst537;
    metrics.scaleFirst537Fallbacks=impl_->scaleFirst537Fallbacks;''',"mode-independent timing")
 c=swap(c,"        completed.time_since_epoch()).count();","        completed537.time_since_epoch()).count();","age time")
 s=swap(s,'#include "hi5stream154/user_capture_policy535.hpp"',
        '#include "hi5stream154/user_capture_policy535.hpp"\n#include "hi5stream154/scale_first537_policy.hpp"',
        "Newtest 537 explicit user helper policy include")
 s=swap(s,"        bool userWgc535CaptureOnly = false;","        bool userWgc535CaptureOnly = false;\n        bool scaleFirst537 = false;","parse state")
 s=swap(s,'''        for(int i=1;i<argc;++i)
            if(std::string(argv[i])=="--wgc535-user-video-only")
                a.userWgc535CaptureOnly=true;''','''        for(int i=1;i<argc;++i){
            if(std::string(argv[i])=="--wgc535-user-video-only")
                a.userWgc535CaptureOnly=true;
            if(std::string(argv[i])=="--wgc537-scale-first")
                a.scaleFirst537=true;
        }''',"scoped Newtest user-helper flag loop")
 s=swap(s,"            hi5::Wgc154Capture capture;\n            std::string reason;",'''            hi5::Wgc154Capture capture;
            const bool scaleFirst537=hi5stream::CanUseScaleFirst537(
                host,true,args.userWgc535CaptureOnly,args.scaleFirst537,
                2560,1600,1280,800,args.display);
            capture.setScaleFirst537(scaleFirst537);
            LogInfo("[hi5stream-537] USER WGC processing mode="+
                    std::string(scaleFirst537?"scale-first":"qualified-536")+
                    " requested_fps="+std::to_string(args.fps));
            std::string reason;''',"only user video set mode")
 s=swap(s,"            uint64_t frames=0;\n            auto report=",'''            uint64_t frames=0;
            uint64_t lastArrivals537=0,lastReplaced537=0,lastMissed537=0;
            double sumConvert537=0,sumScale537=0,sumReadback537=0;
            double sumAge537=0,sumWrite537=0;
            auto report=''', "time sums")
 s=swap(s,"                    if(!shmem.WriteRawI420Frame(frame.frame,stamp)){",'''                    const auto beforeWrite537=std::chrono::steady_clock::now();
                    if(!shmem.WriteRawI420Frame(frame.frame,stamp)){''',"write start")
 s=swap(s,"                    ++frames;\n                    pacer.frame_selected(std::chrono::steady_clock::now());",'''                    const auto afterWrite537=std::chrono::steady_clock::now();
                    sumWrite537+=std::chrono::duration<double,std::milli>(
                        afterWrite537-beforeWrite537).count();
                    ++frames;
                    sumConvert537+=metrics.conversionMs;
                    sumScale537+=metrics.scaleMs;
                    sumReadback537+=metrics.readbackMs;
                    sumAge537+=metrics.frameAgeMs;
                    pacer.frame_selected(std::chrono::steady_clock::now());''',"write/timings end")
 old='''                    LogInfo("[hi5stream-535] user source frames_5s="+std::to_string(frames)+
                        " arrivals="+std::to_string(metrics.sourceFrames)+
                        " empty="+std::to_string(metrics.emptyPolls)+
                        " missed_slots="+std::to_string(pacer.missed_slots())+
                        " conversion_ms="+std::to_string(metrics.conversionMs)+
                        " frame_age_ms="+std::to_string(metrics.frameAgeMs));
                    frames=0;
                    report=std::chrono::steady_clock::now()+std::chrono::seconds(5);'''
 new='''                    const double d537=std::max(1.0,static_cast<double>(frames));
                    LogInfo("[hi5stream-537] A/B mode="+
                        std::string(metrics.scaleFirst537Active?"scale-first":"qualified-536")+
                        " frames_5s="+std::to_string(frames)+
                        " arrivals_5s="+std::to_string(metrics.sourceFrames-lastArrivals537)+
                        " replaced_5s="+std::to_string(metrics.oldFramesReplaced-lastReplaced537)+
                        " missed_slots_5s="+std::to_string(pacer.missed_slots()-lastMissed537)+
                        " readback_avg_ms="+std::to_string(sumReadback537/d537)+
                        " scale_avg_ms="+std::to_string(sumScale537/d537)+
                        " convert_avg_ms="+std::to_string(sumConvert537/d537)+
                        " shmem_avg_ms="+std::to_string(sumWrite537/d537)+
                        " frame_age_avg_ms="+std::to_string(sumAge537/d537)+
                        " fallback_count="+std::to_string(metrics.scaleFirst537Fallbacks));
                    lastArrivals537=metrics.sourceFrames;
                    lastReplaced537=metrics.oldFramesReplaced;
                    lastMissed537=pacer.missed_slots();
                    sumReadback537=sumScale537=sumConvert537=sumAge537=sumWrite537=0.0;
                    frames=0;
                    report=std::chrono::steady_clock::now()+std::chrono::seconds(5);'''
 s=swap(s,old,new,"5s benchmark logs")
 v=swap(v,"                ctx.userWgc535Process=LaunchInInteractiveSession(std::string(exe),cmd);",'''                // Only signed-in USER video worker; SYSTEM/UAC streamers unchanged.
                char mode537[8]{};
                if(GetEnvironmentVariableA("HI5_STREAM_537_SCALE_FIRST",
                    mode537,static_cast<DWORD>(sizeof(mode537)))==1 &&
                    mode537[0]=='1' && host=="DESKTOP-Q9LTF1M")
                    cmd+=" --wgc537-scale-first";
                ctx.userWgc535Process=LaunchInInteractiveSession(std::string(exe),cmd);''',"user helper opt-in")
 for f,hsh in signatures.items():
  if hashfile(Path(f))!=hsh:raise RuntimeError("Protected file changed "+f)
 assert c.count("libyuv::ARGBScale(")==1 and c.count("libyuv::I420Scale(")==1
 assert "LaunchOnSecureDesktop(std::string(exePath), cmdLine)" in v
 assert "Wgc536ShouldRetry(" in v
 assert "IsSecureDesktopActive()" in s
 for p,t in ((cpp,c),(header,h),(stream,s),(service,v)):
  p.write_text(t,encoding="utf-8",newline="\n")
 print("HI5STREAM537_OVERLAY_PASS: alternate=opt-in user WGC; default=exact 536 conversion")
 for f,hsh in signatures.items():print("QUALIFIED_SOURCE_UNCHANGED",Path(f).name,hsh)
if __name__=="__main__":main()
