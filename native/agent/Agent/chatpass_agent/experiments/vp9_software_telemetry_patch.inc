                const auto logNow=std::chrono::steady_clock::now();
                if(m_externalNextStatsLog.time_since_epoch().count()==0)
                    m_externalNextStatsLog=logNow+std::chrono::seconds(5);
                if(logNow>=m_externalNextStatsLog){
                    const double encodedCount=std::max<uint64_t>(1,m_externalEncodedFrames);
                    const double sentCount=std::max<uint64_t>(1,m_externalSentFrames);
                    LogInfo("[vp9] encode health session="+m_sessionId+
                        " submitted="+std::to_string(m_externalEncodedFrames)+
                        " sent="+std::to_string(m_externalSentFrames)+
                        " actual_sent_fps_5s="+std::to_string(
                            static_cast<double>(m_externalSentFrames)/5.0)+
                        " encode_avg_ms="+std::to_string(
                            m_externalEncodeMsTotal/encodedCount)+
                        " encode_max_ms="+std::to_string(m_externalEncodeMsMax)+
                        " send_avg_ms="+std::to_string(
                            m_externalSendMsTotal/sentCount)+
                        " target_fps="+std::to_string(m_externalConfiguredFps)+
                        " bitrate="+std::to_string(m_externalConfiguredBitrateKbps));
                    m_externalEncodedFrames=0;
                    m_externalSentFrames=0;
                    m_externalEncodeMsTotal=0;
                    m_externalEncodeMsMax=0;
                    m_externalSendMsTotal=0;
                    m_externalSendMsMax=0;
                    m_externalNextStatsLog=logNow+std::chrono::seconds(5);
                }
