#include "../src/wgc_pixel_probe_policy.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <utility>
#include <initializer_list>
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
    // Stage 2M: full active-user texture resolution must survive exit encoding.
    for (auto dims : {std::pair<unsigned,unsigned>{2560u,1600u},
                      {3840u,2160u}, {8192u,4320u}, {1024u,768u}}) {
        const auto sizeCode = PackWgcResolution(dims.first, dims.second);
        assert(WgcResolutionValid(sizeCode));
        assert(WgcResolutionWidth(sizeCode) == dims.first);
        assert(WgcResolutionHeight(sizeCode) == dims.second);
        assert(!WgcSustainedValid(sizeCode));
    }
    assert(!WgcResolutionValid(PackWgcResolution(0, 1600)));
    assert(!WgcResolutionValid(PackWgcResolution(2560, 0)));
    for (unsigned count : {1u, 39u, 300u, 600u, 1023u}) {
        const auto sample = PackWgcSustained(count, 4, 12);
        assert(WgcSustainedValid(sample));
        assert(WgcSustainedFrames(sample) == count);
        assert(WgcSustainedAvgReadbackMs(sample) == 4);
        assert(WgcSustainedMaxReadbackMs(sample) == 12);
        assert(!WgcResolutionValid(sample));
    }
    assert(!WgcSustainedValid(PackWgcSustained(0, 4, 12)));
    assert(!WgcResolutionValid(0x80070005u));
    assert(!WgcSustainedValid(0x6b27040fu));
    assert(std::strcmp(WgcPixelFailure(314u),
                       "texture_dimensions_changed_during_probe") == 0);
    std::cout << "wgc_pixel_probe_policy_test PASS\n";
}
