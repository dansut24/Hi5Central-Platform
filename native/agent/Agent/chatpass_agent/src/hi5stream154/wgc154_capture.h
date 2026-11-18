// Copyright (c) 2026 Hi5Central. Proprietary v0.15.4 pilot integration.
#pragma once
#include "frame_source.h"
#include <cstdint>
#include <memory>
#include <string>
namespace hi5 {
struct Wgc154Metrics {
    uint64_t sourceFrames=0,oldFramesReplaced=0,consumedFrames=0;
    uint64_t captureErrors=0,emptyPolls=0;
    double readbackMs=0,conversionMs=0,scaleMs=0,frameAgeMs=0;
};
class Wgc154Capture final {
public:
    Wgc154Capture();
    ~Wgc154Capture();
    Wgc154Capture(const Wgc154Capture&)=delete;
    Wgc154Capture& operator=(const Wgc154Capture&)=delete;
    bool start(std::string& error);
    bool takeLatest(FrameCaptureResult& result,Wgc154Metrics& metrics,
                    std::string& error,unsigned waitMs);
    void stop() noexcept;
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace hi5
