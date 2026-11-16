
        // 529: normal primary desktop only. Defaults off. WGC and GDI never
        // capture the secure desktop through this path.
        hi5::WgcLiveFrameSource wgcLive;
        const bool wgcLiveRequested =
            hi5::EnabledProcessOrMachineCanary("HI5_WGC_LIVE_CANARY") &&
            !isSecureHelper;
        auto wgcNextAttemptAt = std::chrono::steady_clock::now();
        auto wgcNextGdiPollAt = std::chrono::steady_clock::now();
        uint64_t wgcGdiFallbacks = 0;
