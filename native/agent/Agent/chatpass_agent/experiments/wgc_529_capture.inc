
                     FrameCaptureResult captured;
                     bool wgcFrame=false;
                     if (wgcLiveRequested && wgcLive.Active() &&
                         !lastSecureState && currentDisplay==0) {
                         wgcFrame=wgcLive.Take(captured);
                         const uint64_t ageMs=wgcLive.AgeMs();
                         const bool awaitingFirst=ageMs==UINT64_MAX;
                         const bool recentInput=
                             (now-lastInputAt)<std::chrono::milliseconds(1000);
                         const bool staleUnderInput=recentInput && ageMs>300;
                         const bool periodicRecovery=ageMs>1500 &&
                             now>=wgcNextGdiPollAt;
                         if (!wgcFrame && (awaitingFirst || staleUnderInput ||
                                           periodicRecovery)) {
                             captured=source.nextFrameEx();
                             ++wgcGdiFallbacks;
                             wgcNextGdiPollAt=now+std::chrono::milliseconds(500);
                         }
                     } else {
                         captured=source.nextFrameEx();
                     }
