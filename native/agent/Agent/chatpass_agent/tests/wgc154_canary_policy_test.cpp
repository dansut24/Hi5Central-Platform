// Copyright (c) 2026 Hi5Central. WGC154 canary policy regression.
#include "../src/hi5stream154/canary_policy.hpp"
#include "../src/hi5stream154/frame_pacer.hpp"
#include <cassert>
#include <iostream>
#include <string>
int main() {
    using hi5::EvaluateWgc154Canary;
    constexpr auto host="DESKTOP-Q9LTF1M";
    for(int fps:{15,30,45,60}) {
        auto ok=EvaluateWgc154Canary(true,host,false,false,0,fps);
        assert(ok.enabled && std::string(ok.reason)=="qualified-normal-desktop");
    }
    assert(!EvaluateWgc154Canary(false,host,false,false,0,30).enabled);
    assert(!EvaluateWgc154Canary(true,"DESKTOP-OTHER",false,false,0,30).enabled);
    assert(!EvaluateWgc154Canary(true,"DESKTOP-Q9LTF1M-FAKE",false,false,0,30).enabled);
    assert(!EvaluateWgc154Canary(true,host,true,false,0,30).enabled);
    assert(!EvaluateWgc154Canary(true,host,false,true,0,30).enabled);
    assert(!EvaluateWgc154Canary(true,host,false,false,1,30).enabled);
    assert(!EvaluateWgc154Canary(true,host,false,false,0,20).enabled);
    using Pacer=hi5stream::AbsoluteVideoPacer;
    Pacer p(60,Pacer::Time{});
    assert(p.wait_remaining(Pacer::Time{}).count()==0);
    p.frame_selected(Pacer::Time{});
    assert(p.wait_remaining(Pacer::Time{}).count()>16000);
    std::cout<<"WGC154_CANARY_POLICY_AND_ABSOLUTE_PACING_PASS\n";
}
