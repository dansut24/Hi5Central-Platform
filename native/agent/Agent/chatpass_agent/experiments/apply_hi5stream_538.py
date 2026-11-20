#!/usr/bin/env python3
"""Newtest-only 1.0.538 WGC BGRA buffer reuse & independent timing telemetry overlay.
Apply ONLY to fully source-matched 1.0.537 tree. No codec/network/UAC changes.
"""
import argparse, hashlib, pathlib
P=pathlib.Path
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def once(s,old,new,label):
 n=s.count(old)
 if n!=1:raise RuntimeError(f'{label}: expected one exact source anchor, got {n}')
 return s.replace(old,new,1)
def main():
 a=argparse.ArgumentParser()
 a.add_argument('--root',required=True)
 root=P(a.parse_args().root)/'src'
 cpath=root/'hi5stream154/wgc154_capture.cpp'
 hpath=root/'hi5stream154/wgc154_capture.h'
 spath=root/'streamer_main.cpp'
 vpath=root/'platform/windows/windows_service.cpp'
 guard=[root/'webrtc_sender.cpp',root/'webrtc_sender.h',root/'platform/windows/windows_screen.cpp',root/'ipc/session_launcher.cpp']
 pre={str(p):digest(p) for p in guard}
 c=cpath.read_text(encoding='utf-8-sig');h=hpath.read_text(encoding='utf-8-sig')
 s=spath.read_text(encoding='utf-8-sig');v=vpath.read_text(encoding='utf-8-sig')
 if 'reuseBgra538' in c or 'HI5_STREAM_538_REUSE_BGRA' in v:raise RuntimeError('Overlay already applied')
 for x in ('scaleFirst537Fallbacks','source.poll(', 'metrics.scaleFirst537Active='):
  if x not in c:raise RuntimeError('not fully qualified 537 WGC tree: '+x)
 for x in ('[hi5stream-537] A/B mode=', 'scaleFirst537=hi5stream::CanUseScaleFirst537('):
  if x not in s:raise RuntimeError('not fully qualified 537 streamer')
 # Add counters guarded by private producer mutex; all callbacks happen on WGC callback thread.
 h=once(h,'    uint64_t scaleFirst537Fallbacks=0;','    uint64_t scaleFirst537Fallbacks=0;\n    uint64_t bgra538ReuseHits=0,bgra538Allocations=0;','metrics counters')
 h=once(h,'    void setScaleFirst537(bool enabled) noexcept;','    void setScaleFirst537(bool enabled) noexcept;\n    void setReuseBgra538(bool enabled) noexcept;','header option')
 c=once(c,'    std::optional<OwnedFrame> latest;','''    std::optional<OwnedFrame> latest;
    // 538: only one already-consumed BGRA slot, guarded by frames_mutex.
    // Never recycle a frame until the consumer has finished colour conversion.
    std::vector<uint8_t> recycled538;
    bool reuseBgra538=false;
    uint64_t reuseHits538=0,allocations538=0;''','shared pool')
 c=once(c,'        out.bgra.resize(out.byte_length);','''        if(state->reuseBgra538){
            std::lock_guard<std::mutex> guard(state->frames_mutex);
            if(state->recycled538.capacity()>=out.byte_length){
                out.bgra.swap(state->recycled538);
                state->reuseHits538++;
            } else {
                state->allocations538++;
            }
        }
        out.bgra.resize(out.byte_length);''','swap free slot before GPU copy')
 c=once(c,'            if(state->latest)state->replaced++;\n            state->latest=std::move(out);','''            if(state->latest){
                state->replaced++;
                // Only the frame being replaced is dead; do not invalidate
                // an active reader's moved-out frame.
                if(state->reuseBgra538 &&
                   state->latest->bgra.capacity()>state->recycled538.capacity())
                    state->recycled538.swap(state->latest->bgra);
            }
            state->latest=std::move(out);''','recycle overwritten slot')
 c=once(c,'    bool start(std::string& error,bool callback_only,int requested_min_update_ms,','''    void setReuseBgra538(bool enabled) noexcept {reuseRequested538_=enabled;}
    void recycle538(std::vector<uint8_t>&& data) noexcept {
        if(!state_ || !state_->reuseBgra538)return;
        std::lock_guard<std::mutex> guard(state_->frames_mutex);
        if(data.capacity()>state_->recycled538.capacity())
            state_->recycled538=std::move(data);
    }
    bool start(std::string& error,bool callback_only,int requested_min_update_ms,''','capture recycled slot method')
 c=once(c,'            state_=std::make_shared<Shared>();\n            state_->callback_only=callback_only;','''            state_=std::make_shared<Shared>();
            state_->callback_only=callback_only;
            state_->reuseBgra538=reuseRequested538_;''','enable before callbacks')
 c=once(c,'        uint64_t arrived=0,replaced=0,failed=0,resize_events=0;','''        uint64_t arrived=0,replaced=0,failed=0,resize_events=0;
        uint64_t reuseHits538=0,allocations538=0;''','poll counters')
 c=once(c,'        out.arrived=state_->arrived;out.replaced=state_->replaced;','''        out.arrived=state_->arrived;out.replaced=state_->replaced;
        out.reuseHits538=state_->reuseHits538;
        out.allocations538=state_->allocations538;''','copy counters to poll')
 c=once(c,'    bool target_is_window_=false;','''    bool reuseRequested538_=false;
    bool target_is_window_=false;''','source setting member')
 c=once(c,'    bool scaleFirst537=false;','    bool scaleFirst537=false;\n    bool reuseBgra538=false;','impl option')
 c=once(c,'void Wgc154Capture::setScaleFirst537(bool enabled) noexcept {\n    if(impl_ && !impl_->running)impl_->scaleFirst537=enabled;\n}','''void Wgc154Capture::setScaleFirst537(bool enabled) noexcept {
    if(impl_ && !impl_->running)impl_->scaleFirst537=enabled;
}
void Wgc154Capture::setReuseBgra538(bool enabled) noexcept {
    if(impl_ && !impl_->running)impl_->reuseBgra538=enabled;
}''','impl setter')
 c=once(c,'    impl_->running=impl_->source.start(error,false,-1,nullptr);','''    impl_->source.setReuseBgra538(impl_->reuseBgra538);
    impl_->running=impl_->source.start(error,false,-1,nullptr);''','set before start')
 c=once(c,'    metrics.oldFramesReplaced=polled.replaced;','''    metrics.oldFramesReplaced=polled.replaced;
    metrics.bgra538ReuseHits=polled.reuseHits538;
    metrics.bgra538Allocations=polled.allocations538;''','service counters')
 c=once(c,'    metrics.frameAgeMs=nowUs>=static_cast<int64_t>(input.capture_timestamp_us)\n        ? (nowUs-input.capture_timestamp_us)/1000.0 : 0.0;\n    return true;','''    metrics.frameAgeMs=nowUs>=static_cast<int64_t>(input.capture_timestamp_us)
        ? (nowUs-input.capture_timestamp_us)/1000.0 : 0.0;
    // Transfer ownership AFTER libyuv has finished reading the pixels.
    // The callback may use this 16 MB buffer again; at most one slot retained.
    if(impl_->reuseBgra538)
        impl_->source.recycle538(std::move(polled.frame->bgra));
    return true;''','return buffer after conversion')
 s=once(s,'#include <chrono>','#include <chrono>\n#include <filesystem>\n#include <fstream>','separate telemetry logging includes')
 s=once(s,'        bool scaleFirst537 = false;','        bool scaleFirst537 = false;\n        bool reuseBgra538 = false;','streamer bool')
 s=once(s,'            if(std::string(argv[i])=="--wgc537-scale-first")\n                a.scaleFirst537=true;','''            if(std::string(argv[i])=="--wgc537-scale-first")
                a.scaleFirst537=true;
            if(std::string(argv[i])=="--wgc538-reuse-bgra")
                a.reuseBgra538=true;''','parse flag')
 s=once(s,'            capture.setScaleFirst537(scaleFirst537);','''            capture.setScaleFirst537(scaleFirst537);
            const bool reuseBgra538=args.reuseBgra538 &&
                host=="DESKTOP-Q9LTF1M" && args.display==0 &&
                args.fps>=15 && args.fps<=60;
            capture.setReuseBgra538(reuseBgra538);''','guarded opt in')
 s=once(s,'            uint64_t lastArrivals537=0,lastReplaced537=0,lastMissed537=0;','''            uint64_t lastArrivals537=0,lastReplaced537=0,lastMissed537=0;
            uint64_t lastReuseHits538=0,lastAllocations538=0;
            // The interactive helper cannot reliably open SYSTEM-owned
            // ProgramData agent.log. Persist one metrics line / 5s in its
            // user-local private folder; never write in frame callbacks.
            std::ofstream trace538;
            if(const char* appData=std::getenv("LOCALAPPDATA")){
                std::error_code ec;
                std::filesystem::path folder=
                    std::filesystem::path(appData)/"Hi5Central"/"Diagnostics";
                std::filesystem::create_directories(folder,ec);
                if(!ec)
                    trace538.open((folder/"wgc538-newtest.log").string(),
                                  std::ios::out|std::ios::app);
            }''','telemetry state')
 s=once(s,'                    LogInfo("[hi5stream-537] A/B mode="+','''                    if(trace538.is_open()){
                        trace538<<"[hi5stream-538] mode="
                            <<(reuseBgra538?"reuse-bgra":"qualified-537")
                            <<" scale_first="<<(metrics.scaleFirst537Active?1:0)
                            <<" produced_frames_5s="<<frames
                            <<" arrivals_5s="<<(metrics.sourceFrames-lastArrivals537)
                            <<" replaced_5s="<<(metrics.oldFramesReplaced-lastReplaced537)
                            <<" readback_avg_ms="<<(sumReadback537/d537)
                            <<" scale_avg_ms="<<(sumScale537/d537)
                            <<" convert_avg_ms="<<(sumConvert537/d537)
                            <<" shmem_avg_ms="<<(sumWrite537/d537)
                            <<" frame_age_avg_ms="<<(sumAge537/d537)
                            <<" reuse_hits_5s="<<(metrics.bgra538ReuseHits-lastReuseHits538)
                            <<" allocations_5s="<<(metrics.bgra538Allocations-lastAllocations538)
                            <<" missed_slots_5s="<<(pacer.missed_slots()-lastMissed537)
                            <<" fallback_count="<<metrics.scaleFirst537Fallbacks
                            <<"\\n";
                        trace538.flush();
                    }
                    lastReuseHits538=metrics.bgra538ReuseHits;
                    lastAllocations538=metrics.bgra538Allocations;
                    LogInfo("[hi5stream-537] A/B mode="+''','user-local per-5s')
 v=once(v,'                if(GetEnvironmentVariableA("HI5_STREAM_537_SCALE_FIRST",','''                char reuse538[8]{};
                if(GetEnvironmentVariableA("HI5_STREAM_538_REUSE_BGRA",
                    reuse538,sizeof(reuse538))>0 && std::string(reuse538)=="1")
                    cmd+=" --wgc538-reuse-bgra";
                if(GetEnvironmentVariableA("HI5_STREAM_537_SCALE_FIRST",''','service opt in')
 for path,text in [(cpath,c),(hpath,h),(spath,s),(vpath,v)]:path.write_text(text,encoding='utf-8')
 for path in guard:
  if digest(path)!=pre[str(path)]:raise RuntimeError('Protected WebRTC/UAC file changed: '+str(path))
 print('HI5STREAM538_PATCH_PASS: default-OFF BGRA reuse, preserved 537 WGC/VP8/UAC')
 print('SOURCE_SHA',digest(cpath),'STREAMER_SHA',digest(spath))
if __name__=='__main__':main()
