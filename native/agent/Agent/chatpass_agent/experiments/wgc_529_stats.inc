
                if (wgcLiveRequested) {
                    const auto m=wgcLive.Metrics();
                    LogInfo("[wgc-live] telemetry session="+args.sessionId+
                        " active="+std::string(wgcLive.Active() ? "1":"0")+
                        " arrived="+std::to_string(m.arrived)+
                        " converted="+std::to_string(m.converted)+
                        " delivered="+std::to_string(m.delivered)+
                        " cpu_convert_avg_ms="+std::to_string(
                            static_cast<double>(m.copiesUs)/1000.0/
                            std::max<uint64_t>(1,m.converted))+
                        " cpu_convert_max_ms="+std::to_string(
                            static_cast<double>(m.copiesMaxUs)/1000.0)+
                        " errors="+std::to_string(m.failed)+
                        " frame_age_ms="+std::to_string(m.latestAgeMs)+
                        " gdi_recovery_count="+std::to_string(wgcGdiFallbacks));
                }
