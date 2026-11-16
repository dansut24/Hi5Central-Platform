# Hi5Central RMM — locked VP8 native-resolution operating baseline (16 November 2026)

## Decision and scope

**Accepted for the tested Lenovo endpoint's production operation:** Windows Agent **1.0.530**, normal desktop **native 2560 × 1600 GDI capture**, software **VP8/libvpx**, normal WebRTC viewer, requested **60 FPS**. User confirmed the stream and text clarity were working well after native-resolution capture was restored. This replaces the failed 1.0.530 direct-1080p experiment and failed software VP9 test.

**Not yet a customer-distributable general release.** The matching v1.0.530 installer is explicitly `diagnostic_only`, `no_automatic_deployment`, and **unsigned** (verified with Windows Authenticode on both the installer and installed Agent). No fleet-wide deployment, release-feed publication or production signing was performed. A clean, signed production installer and staging/QA gates are required before general promotion. This document records a *production operational baseline*, not a claim that the test binary is production-signed.

## Exact, verified configuration

| Property | Required / observed value |
| --- | --- |
| Agent | 1.0.530; `Hi5CentralAgent` Running and RMM Connected |
| Stream codec | `HI5_CODEC=vp8`; service selected `encoder=libvpx` |
| Capture | Normal full-resolution GDI; no DXGI or WGC live capture |
| Resolution | Native **2560 × 1600** for Lenovo |
| FPS | Machine `HI5_STREAM_FPS=60`, live Agent `fps=60` configured; **actual delivered FPS is not 60** |
| CPU conversion | `HI5_BGRA_I420_FAST_CANARY=1` |
| Full-rate scheduler | `HI5_STREAM_FULL_RATE_CANARY=1` |
| Rejected experiments | `HI5_GDI_DIRECT_1080_CANARY`, `HI5_WGC_LIVE_CANARY`, `HI5_GDI_BITBLT_CANARY`, `HI5_GDI_PERSISTENT_DIB_CANARY`, `HI5_BGRA_Y_SSE2_CANARY` disabled/unset |
| Noted pre-existing discrepancy | Service-specific `HI5_STREAM_FPS=30`, machine `HI5_STREAM_FPS=60`; current service log shows `fps=60`. Do not silently overwrite the known-good environment. Validate precedence before fleet rollout. |

The native VP8 stream remained at approximately **10–12 captured FPS in observed active sessions**. This is a measured limitation, not a claim of full-rate 60 FPS. Next optimisations should measure and address the GDI capture bottleneck while retaining native image clarity.

## Preserved, hash-pinned artifacts

* **Current installed Agent:** `C:\Program Files\Hi5Central\Agent\Hi5CentralAgent.exe`; SHA-256 `f5d99a8fd18f8a82cdde342649563b8cb38162b926e5564ea33cec0be0d82c46`.
* **Test installer used to produce accepted runtime:** `Hi5CentralAgentSetup-1.0.530-DIAGNOSTIC.exe`; SHA-256 `2acfb0b12944c0ac2fd1c77fefc3ceaf99ec63fc3abd3f2cb01a43cdec0d2b4e`.
* **Independently verified rollback installer:** v1.0.528; SHA-256 `9fdde0102c4348ccd266fb55f92ab63be7e4c6690bea989326050cca195dd1ed`.
* **Source package archive:** SHA-256 `476b8f00a19f6d83cb40968d62a64620fbc02074e59aad6794dbaecbadb3b0f3`.
* **GitHub Windows build:** [run 43944658898](https://github.com/dansut24/Hi5Central-Platform/actions/runs/43944658898), 29/29 successful.
* **Private IONOS production VPS backup:** `/opt/hi5central/runtime/backups/rmm-vp8-native-production-baseline-20261116`, verified checksums and root-only access.
* **Private Lenovo backup:** `C:\ProgramData\Hi5Central\Agent\ProductionBaselines\VP8-Native-20261116`; original configuration, service environment and allowlisted runtime metadata with SYSTEM/Administrators ACL only.

Treat the backup as a historical reference. Its installer must not be relabelled as a clean signed production release.

## Production-release guardrails

1. **Retain VP8/libvpx as the approved working software codec and native GDI capture** while improving measured throughput.
2. Never enable direct-1080p or GPU/WGC experiments by default; the lower-resolution experiment yielded only ~10–11 capture FPS and visibly worse text.
3. Do not silently change the codec to H.264 hardware via `HI5_CODEC=auto` when updating this qualified configuration. Verify the **actual service startup log** and machine plus service-level settings after each upgrade.
4. Verify source/installer signatures, all artifact hashes, secure-desktop/UAC handling, normal input, reconnects, no 0-FPS freezes, and real viewer FPS before promoting a new Agent.
5. Require production code signing, a clean build with rejected experiments disabled or removed, controlled QA and rollback, then staged customer rollout. The `rmm_agent_releases` table and customer auto-update feed were **not** populated or activated by this baseline recording.
6. Do not modify the separate EU/AWS test server. Use the original IONOS production VPS.

## Verification evidence

Local baseline preservation RMM job `2e28a46e-82e2-4eed-9f15-8ad478a102b5` **exit 0**; original runtime audit `75c9e9e7-dd2d-469d-adf5-3f6eaf3ec4a0` **exit 0**; native-GDI reversion `7a97ab20-2564-47bf-b95d-13d2afe32791` **exit 0**; Authenticode audit `e1f334b7-9487-4c39-a1b2-f95cc2995e70` **exit 0** (NotSigned). Source trial [PR #201](https://github.com/dansut24/Hi5Central-Platform/pull/201) and VP9 recovery [PR #200](https://github.com/dansut24/Hi5Central-Platform/pull/200) must not be mistaken for customer release qualification.
