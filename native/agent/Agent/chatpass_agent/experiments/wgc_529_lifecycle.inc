
            // A separate Windows capture session is active only while the
            // authenticated interactive user owns the normal desktop. UAC,
            // monitor changes and any WGC startup failure retain GDI.
            if (wgcLiveRequested) {
                if (lastSecureState || currentDisplay != 0) {
                    if (wgcLive.Active()) {
                        wgcLive.Stop();
                        LogInfo("[wgc-live] stopped on secure desktop/monitor change");
                    }
                } else if (!wgcLive.Active() && now >= wgcNextAttemptAt) {
                    std::string reason;
                    const bool started = wgcLive.Start(currentDisplay, reason);
                    LogInfo("[wgc-live] primary desktop start=" +
                        std::string(started ? "1" : "0") +
                        " reason=" + reason);
                    wgcNextAttemptAt = now + std::chrono::seconds(8);
                }
            }
