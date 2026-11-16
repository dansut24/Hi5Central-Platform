#include "../src/wgc_motion_probe_policy.h"
#include <cassert>
#include <iostream>
int main() {
    using namespace hi5;
    assert(WgcMotionTargetAllowed(15));
    assert(WgcMotionTargetAllowed(30));
    assert(WgcMotionTargetAllowed(60));
    assert(!WgcMotionTargetAllowed(0));
    assert(!WgcMotionTargetAllowed(45));
    assert(!WgcMotionTargetAllowed(120));
    assert(kWgcMotionWindowMs == 6000);
    assert(WgcMotionTargetFrames(15) == 90);
    assert(WgcMotionTargetFrames(30) == 180);
    assert(WgcMotionTargetFrames(60) == 360);
    assert(WgcMotionTargetFrames(45) == 0);
    for (unsigned fps : {15u, 30u, 60u}) {
        const auto paints = WgcMotionTargetFrames(fps);
        const auto value = PackWgcMotionMetrics(paints, paints, 5, 12);
        assert(WgcMotionMetricsValid(value));
        assert(WgcMotionFrames(value) == paints);
        assert(WgcMotionPaints(value) == paints);
        assert(WgcMotionMeanMs(value) == 5);
        assert(WgcMotionMaxMs(value) == 12);
    }
    const auto slow = PackWgcMotionMetrics(99, 360, 44, 190);
    assert(WgcMotionMetricsValid(slow));
    assert(WgcMotionFrames(slow) == 99);
    assert(WgcMotionPaints(slow) == 360);
    assert(WgcMotionMeanMs(slow) == 31);
    assert(WgcMotionMaxMs(slow) == 31);
    assert(!WgcMotionMetricsValid(0x80070005u));
    assert(!WgcMotionMetricsValid(309u));
    assert(!WgcMotionMetricsValid(0xC4000000u));
    assert(!WgcMotionMetricsValid(PackWgcMotionMetrics(0, 0, 4, 8)));
    std::cout << "wgc_motion_probe_policy_test PASS\n";
    return 0;
}
