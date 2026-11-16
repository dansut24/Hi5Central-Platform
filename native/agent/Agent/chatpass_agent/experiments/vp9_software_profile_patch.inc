        const bool profileChangedVp9=hi5::Vp9SwProfileChange(
            m_externalConfiguredFps,m_externalConfiguredBitrateKbps,
            profile.fps,profile.bitrateKbps);
        if(m_vp9Encoder && !sizeChangedVp9 && profileChangedVp9 &&
           m_codecMode=="vp9_sw") {
            if(m_vp9Encoder->reconfigure(profile.fps,profile.bitrateKbps)){
                m_externalConfiguredFps=profile.fps;
                m_externalConfiguredBitrateKbps=profile.bitrateKbps;
                LogInfo("[vp9] libvpx profile update session="+m_sessionId+
                    " fps="+std::to_string(profile.fps)+
                    " bitrate="+std::to_string(profile.bitrateKbps));
            }else{
                m_vp9Encoder.reset();
                m_forceKeyframe=true;
            }
        }

