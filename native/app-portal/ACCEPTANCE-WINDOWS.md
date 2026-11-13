# Hi5Central Windows Software Self-Service — live acceptance

**Target:** original Hi5Central production VPS, RMM tenant \`newtest\`, current Windows devices (Lenovo and Dell). No separate EU environment.

## Confirmed 13 November 2026

- The App Portal exists as Avalonia/.NET 8 \`native/app-portal\` and is bundled by the Windows Agent installer. A self-contained App Portal EXE is also produced by \`.github/workflows/app-portal.yml\`.
- The privileged Agent exposes a local Windows message-mode named pipe \`Hi5CentralAppPortal\`. The UI does **not** elevate, handle Agent secrets, or install software itself.
- RMM server App Portal tables are present, but there are **zero** published tenant apps, assignments, approval requests and installations.
- The \`newtest\` RMM tenant has one Connected and one Disconnected Agent device in the current DB. Other tenants have no registered Agents.
- Global software catalogue contains 130 entries marked \`qualified\`, including \`Notepad++\` and \`VLC media player\`; there are no registered qualification runners. Qualification status is an existing DB claim, **not a fresh installer requalification**.
- Source code has Home, All Apps, Updates, Installed, Requests, My Device, Help & Support and Settings. Help & Support actions are placeholders, not working ITSM ticket/script actions yet.

## Build and installation

1. Open the GitHub Actions **App Portal** workflow for branch \`fix/app-portal-live-sync-timeouts-20261113\`. Confirm Windows job and named-pipe tests pass.
2. Download artifact \`Hi5Central-App-Portal-Windows\`; extract the self-contained Windows executable. This is an **application artifact**, **not a replacement Agent installer**.
3. Use on a Windows device with the compatible Hi5Central Agent installed and running. The endpoint must expose \`\\\\.\\pipe\\Hi5CentralAppPortal\`. If the Agent is not installed or exposes a different broker, the app must show an actionable connection error.
4. Open under the **standard signed-in Windows user**, not as Administrator, and check no elevation prompt occurs.

## Test cases to record in tests.hi5central.com

- **APP-001:** Windows app opens as standard user with correct UI and no UAC prompt.
- **APP-002:** Local broker catalogue loads within 15 seconds; Agent disconnect/reconnect and caller cancellation recover. IPC smoke tests are **not** a substitute for a live Agent test.
- **APP-003:** In \`newtest\` RMM Admin, publish an existing **qualified** catalogue application, then assign it \`Available\` to the correct Device, User, Group or Estate. The app should appear within 60 seconds without manual refresh. Do **not** choose Required for the first test; that could trigger automatic installation.
- **APP-005:** With \`Approval required\`, request software and confirm only the right tenant's Admin sees it; approval/rejection and display refresh must work.
- **APP-006:** Press Install for an explicitly assigned, qualified application. Verify Agent/PatchHost job receipt, hash/signature checks, actual installed version and matching status. Avoid testing installation on devices without explicit user authorisation.
- **APP-009:** Simulate Agent unavailability and a stalled broker; the UI must recover, not spin indefinitely. If an Install request times out, refresh first: the install may already have been accepted.
- **APP-010:** Installed and request history must match the actual endpoint, not a simulated status.

## Limitations

- Publishing from software catalogue still requires Admin permissions and an authorised tenant session. Never insert directly into tenant tables to bypass checks or fabricate qualification results.
- The Software Self-Service UI is currently functional only with the **Windows** named-pipe Agent. Linux/macOS builds are UI compilation artifacts with unimplemented brokers.
- \`Help & Support\` actions (ticket creation, knowledge, chat, remote assistance) are presently disabled placeholders; end-user scripts also need a governed design. Do not mark them complete.
- Current UI has minimum window width 1050; APP-011 (low-resolution and 150% scaling) needs dedicated regression work.
- Release/Agent packaging is separate: do not modify currently proven RMM streaming, codec selection, CAD/UAC or existing viewers as part of App Portal testing.

## What this branch fixes

- Automatically refresh the available application catalogue every ~60 seconds even when no installation or approval is pending.
- Continue more frequent refreshes while requests are pending or Agent disconnected.
- Bound each Agent IPC operation including reads and writes; preserve 5-second connect deadline.
- Add Windows local named-pipe protocol tests, plus protect new errors from being dismissed by an older success banner.
