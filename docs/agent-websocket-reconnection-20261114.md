# Windows Agent WebSocket reconnection — 14 November 2026

## Verified diagnosis on Newtest Lenovo

Test device: `DESKTOP-Q9LTF1M`, originally running Windows Agent 1.0.507.

At **2026-11-14 16:03:51 UTC**, the shared RMM API was recreated as `hi5central/rmm-api:laps-vault-list-fix-20261114` (Docker `StartedAt=2026-11-14T16:03:51.335Z`). The Windows Agent logged `websocket closed; stopping active remote sessions and streamer helpers` in the same second, then `worker stopped` at 16:03:54 and `service state -> STOPPED` at 16:03:56. No Service Control Manager crash was logged for that shutdown. The service only came back at 16:14:45.

Code defect in `native/agent/Agent/chatpass_agent/src/platform/windows/windows_service.cpp`: the WebSocket close handler directly executed `stop_.store(true)`, causing the entire Windows Service's `Worker::Run()` to exit. Every RMM API deployment, WebSocket interruption or network outage could therefore stop the Windows Agent until an external restart.

Separately, Windows Error Reporting recorded genuine native `0xc0000005` access-violation crashes on **11 November** (old Agent) and **14 November 15:57:42** (immediately after installation of 1.0.507). A minidump was captured on the device and analysed locally using Microsoft CDB; no corresponding PDB was available for that exact binary. Do not attribute these crashes to Task Scheduler or to the WebSocket stop defect without additional symbolic evidence.

The Lenovo had approximately 28 historical Hi5Central scheduled upgrade/recovery tasks, but no matching task-run evidence at 16:03. Its hourly Self-Service task last ran at 15:02, not at the incident. Service recovery actions already existed (60s / 5min / 15min), but these do **not** handle clean `SERVICE_STOPPED` after an application-requested stop.

## Agent 1.0.508 change

- On WebSocket closure, mark the signaling connection offline and ask the **existing Worker** to reconnect, without setting the Agent service stop flag.
- Close any active remote session and clean up its streamer helpers on the Worker thread (not inside the libdatachannel callback).
- Reconnect in place with 2–60s exponential backoff. The Agent's telemetry, job loop, patch discovery and self-service broker remain intact.
- Re-send the Agent hello and inventory snapshot on WebSocket open.
- Harden `SignalingClient` socket replacement: generation-bound callbacks, lifetime gate/drain during teardown, no raw `this` captured by libdatachannel callbacks, synchronised socket ownership and non-throwing send/teardown when an old socket closes during replacement.
- Windows Agent CI workflow builds version 1.0.508 and publishes a SHA-256-verifiable setup installer, with a best-effort debug symbols artifact for subsequent crashes.

## Required live verification

1. Build the exact feature-branch commit in the Windows GitHub workflow. Do not deploy on a failed build.
2. Stage `Hi5CentralAgentSetup.exe` under `https://downloads.hi5central.com/rmm-agent/1.0.508/` and verify its SHA-256.
3. Upgrade only the Newtest Lenovo through the existing RMM `custom.command` scheduled-task handoff and independently verify it reconnects reporting 1.0.508. Retain the 1.0.507 installer for rollback.
4. Read the Windows Agent service's PID/start time and the current SCM Event 7031 count.
5. Deliberately restart the **shared RMM API** once while monitoring the device (coordinate because other tenant sessions can be interrupted), or use an authorised targeted WebSocket disconnect.
6. Confirm the Agent logs show WebSocket disconnection and reconnection **without** `worker stopped` or `service state -> STOPPED`, its PID/start time remains unchanged, its first hello re-registers, telemetry/job polling continue, and the Self-Service Broker stays running.
7. Check Windows Error Reporting for new `c0000005` crashes. If one occurs, capture/symbolise its local minidump using the matching 1.0.508 PDB artifact; do not transport raw crash dumps into server logs or ticket records.
8. Once stable, continue the dedicated Hi5Recovery escrow/rotation/MFA-reveal test. Do not change administrator passwords in the course of this reconnection test.

Rollback: reinstall the retained trusted 1.0.507 artifact if 1.0.508 misbehaves. Note that 1.0.507 has the known WebSocket-shutdown defect and must not be treated as a production-stable baseline.

## Live validation completed (2026-11-14, 16:57 UTC)

- Windows CI: `Agent deployment installers` workflow run **43616356492**, Windows job **success**. Release artifact `Hi5Central-Windows-Agent-1.0.508-WSReconnect`.
- Installer `https://downloads.hi5central.com/rmm-agent/1.0.508/Hi5CentralAgentSetup.exe`, SHA-256 `30a4b92d5ceee062173abec425e876341f5711d067cba76ad86398eee28e02df`, staged and verified on original VPS.
- Newtest Lenovo `DESKTOP-Q9LTF1M` upgraded by RMM job `7081985a-0a94-40e1-bd50-0b92dba8c1f4` at 16:51, status `succeeded_after_reconnect`, Agent version 1.0.508 independently recorded by RMM API. Previous 1.0.507 installer retained.
- **Separate crash caution:** Windows recorded an Agent `0xc0000005` Application Error at 16:52:50 during the upgrade/restart period, and Service Control Manager Event 7031 at 16:52:55. The replacement service process started 16:52:56, PID **14900**, and was stable through subsequent tests. This crash is not evidence that the reconnection fix failed; the precise native crash cause remains unresolved.
- Before controlled API interruption (16:56:11 UTC), PostgreSQL confirmed **zero active remote/tool sessions** and just one freshly authenticated Agent (Newtest Lenovo).
- Original RMM API container intentionally restarted at 16:56:11–16:56:22 UTC; it returned healthy with HTTP 200.
- Lenovo log: `16:56:22 websocket disconnected; keep Windows service running and reconnect`; `16:56:25 websocket unavailable; reconnecting in place without stopping Agent`; `16:56:25 websocket connected` followed by `hello sent`.
- Agent continued reporting telemetry and accepting `custom.command` jobs; subsequent audit job `29d71db1-76cf-4084-b605-cb008b584c23` succeeded.
- Post-test Windows read-only audit at 16:57:17 UTC: Hi5CentralAgent **Running**, PID **14900**, process start **16:52:56.246Z** (same as before the API restart); independent Hi5CentralSelfServiceBroker **Running**, PID **17556**; no new SCM Event 7031/7034 and no new WER Event 1000/1001 after 16:56. **Live WebSocket reconnection without service stop is verified.**
- Current feature status: original WebSocket-close clean-stop defect **resolved and proven** on 1.0.508. Separate historical and upgrade-time native `0xc0000005` crashes still require root-cause analysis with matching symbol files and repeated stability tests; do not claim all crash issues are fixed.
- No local administrator account password changes or LAPS rotations occurred in this test.
