// Hi5Central candidate codec policy v1 -- OFFLINE ONLY, NOT WIRED TO LIVE SESSIONS.
// A codec can be chosen only if both the sender and negotiated viewer support it,
// the encoder has passed real-time qualification and it is not in a cooldown.
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
namespace hi5stream {
enum class Codec : uint8_t { VP8, VP9, H264, AV1, H265 };
enum class Preference : uint8_t { Auto, Manual };
enum class Tier : uint8_t { Constrained, Balanced, High };
struct Candidate {
    Codec codec=Codec::VP8;
    bool senderSupported=false, viewerSdpSupported=false;
    bool qualified=false, hardware=false;
    double encoderMsP95=0, decoderMsP95=0;
    bool recentlyFailed=false;
};
struct Conditions {
    int availableKbps=0;   // 0 = unknown; never interpret unknown as zero bandwidth
    int targetFps=60, cpuUtilPct=0;
    double rttMs=0, lossPct=0, jitterBufferMs=0;
};
struct Decision {
    Codec codec=Codec::VP8;
    Tier tier=Tier::Balanced;
    int fps=30, bitrateKbps=3500;
    bool manualHonoured=false;
    bool requireRenegotiation=false;
    const char* reason="VP8 stable default";
};
inline bool Usable(const Candidate& x,int frameBudgetMs) noexcept {
    if(!x.senderSupported||!x.viewerSdpSupported||!x.qualified||x.recentlyFailed)return false;
    if(x.encoderMsP95<=0 || x.decoderMsP95<=0)return false; // Don't infer real-time fitness from hardware probe alone
    return x.encoderMsP95<=frameBudgetMs && x.decoderMsP95<=frameBudgetMs;
}
inline Tier QualityTier(Conditions c) noexcept {
    // Measured congestion affects quality first; codec changes are not a
    // first response to a brief spike in RTT or packet loss.
    if((c.availableKbps>0 && c.availableKbps<2200) ||
       c.lossPct>=3.0 || c.rttMs>=240 || c.jitterBufferMs>=120) return Tier::Constrained;
    if(c.availableKbps>=6500 && c.lossPct<1.0 && c.rttMs<130 &&
       c.jitterBufferMs<70) return Tier::High;
    return Tier::Balanced;
}
inline Decision ChooseInitialCodec(
    const std::array<Candidate,5>& available,Conditions c,
    Preference pref=Preference::Auto,Codec manuallySelected=Codec::VP8) noexcept {
    Decision d;
    d.tier=QualityTier(c);
    const int requestedFps=std::max(15,std::min(60,c.targetFps));
    d.fps=d.tier==Tier::Constrained ? std::min(30,requestedFps) : requestedFps;
    const int estimated=c.availableKbps>0?c.availableKbps:4500;
    const int rateCap=d.tier==Tier::Constrained?1800:
                      d.tier==Tier::High?9000:5500;
    d.bitrateKbps=std::max(600,std::min(rateCap,int(estimated*0.75)));
    const int maxEncodeMs=std::max(12,1000/d.fps*2);
    auto get=[&](Codec id)->const Candidate*{
        for(const auto& x:available)if(x.codec==id)return &x;
        return nullptr;
    };
    auto viable=[&](Codec id)->bool{
        const Candidate* x=get(id);
        return x && Usable(*x,maxEncodeMs);
    };
    if(pref==Preference::Manual){
        if(viable(manuallySelected)){
            d.codec=manuallySelected;d.manualHonoured=true;
            d.reason="Qualified manual codec and negotiated SDP";
            return d;
        }
        d.codec=Codec::VP8;
        d.reason="Manual codec unsupported/unqualified, VP8 safe fallback";
        return d;
    }
    // Unknown throughput or unqualified codecs: preserve stable VP8.
    if(c.availableKbps<=0){
        d.codec=Codec::VP8;
        d.reason="Unknown throughput, qualified VP8 safe initial session";
        return d;
    }
    // Under bandwidth pressure prefer compressed codecs only if fast enough,
    // otherwise stick to VP8 and reduce FPS/bitrate instead of freezing.
    if(d.tier==Tier::Constrained){
        if(viable(Codec::AV1)){d.codec=Codec::AV1;d.reason="Qualified AV1 at constrained bitrate";return d;}
        if(viable(Codec::VP9)){d.codec=Codec::VP9;d.reason="Qualified VP9 at constrained bitrate";return d;}
        d.reason="Congestion: reduce VP8 quality, avoid unqualified codec";
        return d;
    }
    // Avoid software-encoder CPU contention at high desktop-motion rates.
    if(c.cpuUtilPct>=75){
        if(viable(Codec::H264) && get(Codec::H264)->hardware){
            d.codec=Codec::H264;d.reason="Qualified hardware H264 under CPU pressure";return d;
        }
        if(viable(Codec::H265) && get(Codec::H265)->hardware){
            d.codec=Codec::H265;d.reason="Qualified hardware H265 under CPU pressure";return d;
        }
        d.reason="High CPU without qualified hardware encoder; VP8 fallback";return d;
    }
    if(viable(Codec::H264) && get(Codec::H264)->hardware){
        d.codec=Codec::H264;d.reason="Qualified hardware H264 for responsive desktop";return d;
    }
    if(d.tier==Tier::High && viable(Codec::H265) && get(Codec::H265)->hardware){
        d.codec=Codec::H265;d.reason="Qualified hardware H265 and SDP negotiation";return d;
    }
    if(viable(Codec::VP9) && c.availableKbps<4200){
        d.codec=Codec::VP9;d.reason="Qualified VP9 at medium bandwidth";return d;
    }
    d.reason="Qualified VP8 stable fallback";
    return d;
}
struct SwitchState {
    uint32_t secondsSinceLastSwitch=0;
    uint8_t consecutiveBadWindows=0;
    bool currentCodecBlackScreen=false;
};
inline bool ShouldRenegotiate(SwitchState s) noexcept {
    // No churn on a single bad measurement. Black screen is the only exception.
    if(s.currentCodecBlackScreen)return true;
    return s.secondsSinceLastSwitch>=120 && s.consecutiveBadWindows>=3;
}
} // namespace hi5stream
