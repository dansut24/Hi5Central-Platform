// Copyright (c) 2026 Hi5Central. Proprietary real-frame scheduler.
// Absolute cadence: do not consume a WGC frame before it is due.
// The capture callback independently keeps the newest frame.
// This is pure portable C++ for deterministic timing regression tests.
#pragma once
#include <chrono>
#include <cstdint>
#include <stdexcept>
namespace hi5stream {
class AbsoluteVideoPacer {
public:
    using Clock=std::chrono::steady_clock;
    using Time=Clock::time_point;
    using Micro=std::chrono::microseconds;
    AbsoluteVideoPacer(unsigned target_fps,Time start)
        : interval_(1000000/static_cast<int>(target_fps)),deadline_(start) {
        if(target_fps!=15 && target_fps!=30 &&
           target_fps!=45 && target_fps!=60)
            throw std::invalid_argument("Unsupported frame target");
    }
    Time deadline() const noexcept {return deadline_;}
    Micro wait_remaining(Time now) const noexcept {
        if(now>=deadline_)return Micro(0);
        return std::chrono::duration_cast<Micro>(deadline_-now);
    }
    void record_wait(Micro waited) noexcept {
        if(waited.count()>0) {
            ++wait_count_;
            wait_total_us_+=static_cast<uint64_t>(waited.count());
        }
    }
    void frame_selected(Time selected) noexcept {
        // A delay in capture or encoding never shifts the original
        // cadence origin. Skip old deadline slots instead of piling
        // up a backlog. A slow WGC source can still be encoded on
        // each arrival with the appropriate missed-slot count.
        if(selected<deadline_)selected=deadline_;
        const auto late=std::chrono::duration_cast<Micro>(
            selected-deadline_).count();
        const uint64_t missed=static_cast<uint64_t>(late/interval_.count());
        missed_slots_+=missed;
        deadline_+=interval_*static_cast<int64_t>(missed+1);
        ++selected_frames_;
    }
    unsigned target_fps()const noexcept {
        return static_cast<unsigned>(1000000/interval_.count());
    }
    uint64_t missed_slots()const noexcept {return missed_slots_;}
    uint64_t wait_count()const noexcept {return wait_count_;}
    uint64_t selected_frames()const noexcept {return selected_frames_;}
    uint64_t total_wait_us()const noexcept {return wait_total_us_;}
private:
    Micro interval_;
    Time deadline_;
    uint64_t missed_slots_=0,wait_count_=0,selected_frames_=0;
    uint64_t wait_total_us_=0;
};
} // namespace hi5stream
