#include "../src/hi5stream154/wgc536_recovery_policy.hpp"
#include <cassert>
#include <iostream>
int main() {
    using namespace hi5stream;
    assert(Wgc536NormalReady(true,true,false,false,true,false,false,true,0,true));
    assert(!Wgc536NormalReady(false,true,false,false,true,false,false,true,0,true));
    assert(!Wgc536NormalReady(true,true,true,false,true,false,false,true,0,true));
    assert(!Wgc536NormalReady(true,true,false,true,true,false,false,true,0,true));
    assert(!Wgc536NormalReady(true,true,false,false,false,false,false,true,0,true));
    assert(!Wgc536NormalReady(true,true,false,false,true,false,true,true,0,true));
    assert(!Wgc536NormalReady(true,true,false,false,true,false,false,false,0,true));
    assert(!Wgc536NormalReady(true,true,false,false,true,false,false,true,1,true));
    assert(!Wgc536NormalReady(true,true,false,false,true,false,false,true,0,false));
    assert(Wgc536RetryDelayMs(0)==2000);
    assert(Wgc536RetryDelayMs(1)==5000);
    assert(Wgc536RetryDelayMs(2)==10000);
    assert(Wgc536RetryDelayMs(3)==30000);
    assert(Wgc536RetryDelayMs(1000)==30000);
    assert(!Wgc536ShouldRetry(true,899,30000,0));
    assert(!Wgc536ShouldRetry(true,2000,1999,0));
    assert(Wgc536ShouldRetry(true,900,2000,0));
    assert(!Wgc536ShouldRetry(true,900,4900,1));
    assert(Wgc536ShouldRetry(true,900,5000,1));
    assert(!Wgc536ShouldRetry(false,10000,60000,0));
    for (int fps: {15,30,45,60}) {
        assert(Wgc536Vp8Fps(true,false,false,2,fps,20)==fps);
        assert(Wgc536Vp8Fps(false,false,false,2,fps,20)==20);
        assert(Wgc536Vp8Fps(true,true,false,2,fps,20)==20);
        assert(Wgc536Vp8Fps(true,false,true,2,fps,20)==20);
        assert(Wgc536Vp8Fps(true,false,false,3,fps,20)==20);
    }
    assert(Wgc536Vp8Fps(true,false,false,2,20,20)==20);
    std::cout << "HI5STREAM536_RECOVERY_AND_WGC_ONLY_VP8_FPS_PASS\n";
}
