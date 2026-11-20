// Offline deterministic tests for proposed auto-codec policy, not connected to sessions.
#include "auto_codec_v1_policy.hpp"
#include <array>
#include <cassert>
#include <iostream>
using namespace hi5stream;
static Candidate good(Codec id,bool hw=false,double enc=8,double dec=5) {
    return Candidate{id,true,true,true,hw,enc,dec,false};
}
int main(){
    std::array<Candidate,5> x{good(Codec::VP8),good(Codec::VP9),good(Codec::H264,true),good(Codec::AV1),good(Codec::H265,true)};
    Conditions c; c.targetFps=60;
    auto d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::VP8 && d.fps==60 && !d.manualHonoured);
    // Known low bandwidth: qualified AV1 preferred, but reduce streaming rate first.
    c.availableKbps=1600;
    d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::AV1 && d.fps==30 && d.bitrateKbps<=1600);
    x[3].encoderMsP95=150;
    d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::VP9);
    x[1].viewerSdpSupported=false;
    d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::VP8 && d.fps==30);
    // A device running hot should favour qualified hardware H264, not assume all
    // installed hardware encoders are WebRTC usable.
    c.availableKbps=9500;c.cpuUtilPct=89;
    d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::H264 && d.fps==60);
    x[2].viewerSdpSupported=false;
    d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::H265);
    x[4].qualified=false;
    d=ChooseInitialCodec(x,c);
    assert(d.codec==Codec::VP8);
    // Manual override honoured only if SDP negotiated and real-time qualified.
    x[1].viewerSdpSupported=true;
    d=ChooseInitialCodec(x,c,Preference::Manual,Codec::VP9);
    assert(d.codec==Codec::VP9 && d.manualHonoured);
    d=ChooseInitialCodec(x,c,Preference::Manual,Codec::H265);
    assert(d.codec==Codec::VP8 && !d.manualHonoured);
    // Don't try automatic codec switches on isolated loss spikes.
    assert(!ShouldRenegotiate({5,1,false}));
    assert(!ShouldRenegotiate({130,2,false}));
    assert(ShouldRenegotiate({130,3,false}));
    assert(ShouldRenegotiate({5,0,true}));
    // High jitter and loss must prioritise reduced rate, even on fast links.
    c.availableKbps=10000;c.lossPct=5;c.rttMs=80;
    d=ChooseInitialCodec(x,c);
    assert(d.tier==Tier::Constrained && d.fps==30);
    c.lossPct=0;c.jitterBufferMs=140;
    d=ChooseInitialCodec(x,c);
    assert(d.tier==Tier::Constrained);
    c.jitterBufferMs=0;c.rttMs=280;
    d=ChooseInitialCodec(x,c);
    assert(d.tier==Tier::Constrained);
    std::cout<<"HI5STREAM_AUTO_CODEC_V1_OFFLINE_POLICY_PASS"<<std::endl;
}
