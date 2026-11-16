#include "../src/vp9_realtime_policy.h"
#include <cassert>
#include <chrono>
#include <iostream>
int main() {
    using namespace std::chrono;
    using hi5::Vp9Clock90k;
    using hi5::Vp9FrameDuration90k;
    using hi5::Vp9SwProfileChange;
    const auto base=steady_clock::time_point{};
    const auto t0=Vp9Clock90k(base,base,0u);
    const auto idle=Vp9Clock90k(base,base+milliseconds(500),t0);
    const auto wake=Vp9Clock90k(base,base+milliseconds(520),idle);
    const auto motion=Vp9Clock90k(base,base+milliseconds(536),wake);
    assert(t0==1u);
    assert(idle >= 44999u && idle <= 45001u);
    assert(wake >= 46799u && wake <= 46801u);
    assert(motion >= 48239u && motion <= 48241u);
    assert(Vp9FrameDuration90k(idle,t0) >= 44000u);
    assert(Vp9FrameDuration90k(motion,wake) >= 1300u);
    assert(Vp9Clock90k(base,base+milliseconds(5),motion)==motion+1u);
    assert(Vp9Clock90k(base,base-milliseconds(5),motion)==motion+1u);
    assert(Vp9FrameDuration90k(900001,1)==90000);
    assert(Vp9FrameDuration90k(1,1)==1);
    assert(Vp9SwProfileChange(2,1200,60,2000));
    assert(!Vp9SwProfileChange(60,2000,60,2000));
    assert(Vp9SwProfileChange(60,2000,30,2000));
    std::cout<<"vp9_realtime_policy_test PASS idle2_to_motion60_monotonic=1\n";
}
