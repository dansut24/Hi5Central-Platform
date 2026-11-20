# Newtest Hi5Stream 1.0.539: source-FPS isolation test

Date: 2026-11-20. Primary IONOS VPS only; no EU changes.

## Reason for build

The Newtest Lenovo DESKTOP-Q9LTF1M on 1.0.538 reached ~11.7 source FPS without and ~12.2 FPS with reusable BGRA buffers, despite dramatically improved GPU readback (~14.7 ms vs ~4.7 ms) and frame age (~33.9 ms vs ~20.1 ms). Five-second WGC helper source-arrival counts matched service-forwarded counts (~12 FPS). The standalone v0.15.4 test achieved 29.90 FPS at target 30 and 50.87 FPS at target 60. The browser separately reported ~29.5 received, ~29.7 decoded and ~27.1 presented in an earlier viewer sample.

The bottleneck may be callback frequency, presentation/desktop activity, redundant GDI capture, or encoding contention. We have **not** established which causal mechanism dominates. This canary isolates redundant GDI capture and retains independent stream metrics.

The previous 1.0.538 A/B test ran and then explicitly restored Newtest to qualified 1.0.537. Do not overwrite that baseline without a guarded, opt-in requalification step.

## Test-only change

- Reconstructs qualified 1.0.530 plus the source-matched 534, 535, 536, 537, 538 overlays.
- Adds `HI5_STREAM_539_GDI_STANDBY=1` independent OFF-by-default service opt-in, on Newtest Lenovo only and only when `HI5_STREAM_V154_WGC_CANARY=1`.
- A service-created per-session manual-reset event directs only the normal SYSTEM capture helper to skip expensive redundant capture when the interactive USER WGC helper is alive and sent a fresh frame within 220 ms.
- The SYSTEM helper **continues to run and process keyboard, mouse and desktop state**. Secure helper/UAC, service auth, WebRTC signalling and codecs are untouched.
- Event resets on WGC source loss, UAC/secure desktop, backstage, monitor change, console switch, normal helper relaunch, stop and session cleanup. If event creation/opening fails, original GDI capture remains enabled.
- Keeps 537 scale-first and 538 reusable BGRA independently selectable; neither is automatically enabled by installing 539.

## Controlled comparison (three-minute each, same actively changing scene)

1. Baseline qualified 537 at 60 FPS to ensure canary output is comparable; record the viewer JSON and existing diagnostic counters.
2. 539 with WGC=1, scale-first=1, BGRA-reuse=1, **GDI-standby=0**, VP8 encoder threads=2.
3. 539 with identical settings except **GDI-standby=1**, threads=2.
4. 539 with GDI-standby=1 and `HI5_VP8_THREADS=4` (as used by isolated Hi5Stream), keeping all other settings constant.
5. Optional control: GDI-standby=0, threads=4, to separate encoder effects from capture contention.

At each phase collect: WGC produced and arrived FPS, replaced/dropped frames, readback/convert/scale/shmem ms, standby ticks and event transitions, service forwarded FPS, VP8 target and encoded FPS, browser received/decoded/presented FPS, bitrate, packet loss, jitter, CPU/GPU load, frame age p95, input/UAC continuity.

**Important:** WGC reports new content updates, not a guaranteed stream of frames on an idle desktop. Compare using the same continuously animated desktop workload and the same device resolution; distinguish low source updates from pipeline drop.

## Safety and acceptance

- Windows installer remains unsigned diagnostic-only / Newtest-only until approved.
- Preserve the SHA-verified 1.0.537 installer (current qualified live rollback) and untouched original production platform; no automatic deployment.
- Fail/rollback upon any UAC, input, remote connection regression, freezes, standby that persists after WGC is lost, or significant decrease in forwarded/presented FPS.
- Only qualify when sustained 30 FPS and 60-setting performance approach the standalone throughput, and browser receives/decodes/presents the sent frames without stutter.
- Even with a 60-FPS target, measured presentation can be below 60 if source desktop is idle, monitor refresh is ~59 Hz, or the host cannot produce 60 distinct frames.

## Continuation summary

As of this staging work: live agent was 1.0.537; 538 source-measured WGC 11.7/12.2 FPS despite BGRA improvement; 539 GDI-standby opt-in was source-matched against the reconstructed 538 tree and policy-tested locally. Windows CI build and live 539 benchmark remain to be checked before any live upgrade.
