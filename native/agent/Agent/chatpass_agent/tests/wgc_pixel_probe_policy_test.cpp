#include "../src/wgc_pixel_probe_policy.h"
#include <cassert>
#include <cstring>
#include <iostream>
int main() {
    using namespace hi5;
    assert(WgcPixelDimensionsAllowed(2560, 1600, 2560 * 4));
    assert(!WgcPixelDimensionsAllowed(0, 1600, 10240));
    assert(!WgcPixelDimensionsAllowed(2560, 1600, 9000));
    assert(!WgcPixelDimensionsAllowed(8193, 1080, 8193 * 4));
    assert(!WgcPixelDimensionsAllowed(8192, 4320, 8192 * 4));
    auto code = PackWgcPixelFrames(31, 4, 9);
    assert(WgcPixelHasFrames(code));
    assert(WgcPixelFrames(code) == 31);
    assert(WgcPixelAverageReadbackMs(code) == 4);
    assert(WgcPixelMaximumReadbackMs(code) == 9);
    assert(!WgcPixelHasFrames(0x80070005u));
    assert(!WgcPixelHasFrames(0x6a1f13c5u));
    assert(!WgcPixelHasFrames(309u));
    assert(std::strcmp(WgcPixelFailure(310u), "readback_failed") == 0);
    assert(std::strcmp(WgcPixelFailure(0x80070005u),
                       "wgc_access_denied") == 0);
    std::cout << "wgc_pixel_probe_policy_test PASS\n";
}
