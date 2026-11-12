# Hi5Central RMM native iOS keyboard and Windows focus – 12 November 2026

## Verified recovery baseline
- iOS v0.5.12 restored native video (correct VP9/VP8 decoder factory and RMM TURN route).
- iOS v0.5.13 native system keyboard, Windows shortcut toolbar, remote touch and zoom independently verified on iPhone.
- iOS v0.5.14 full-width UK laptop QWERTY and separate Num pad confirmed usable in user screenshot. It is visibly cramped in portrait, hence optional.
- Windows Agent v1.0.318 previously streamed successfully; DO NOT overwrite until isolated focus-helper build is verified.
- Dedicated RMM API and original IONOS VPS remain untouched.

## v0.5.15 iOS implementation
Branch: `feature/rmm-ios-v0515-auto-native-keyboard-focus`.
Files: `NativeRemoteEngine.swift`, `NativeRemoteViewerScreen.swift`, `project.yml`.
- Native iOS keyboard selected by default (persisted `h5c.rmm.keyboard.preference`).
- Laptop/iOS buttons preserve a persistent user choice.
- Existing slim Windows shortcut strip retained over native keyboard.
- Receive Agent focus through allowlisted WebSocket message `{type:"session_state",state:"input_focus_editable"|"input_focus_cleared", keyboard_kind:"text"|"url"|"password"}`.
- Compatibility for `remote_focus_state` via native data channel; no changes to WebRTC SDP, capture, codecs, TURN, ICE or Caddy.
- On newly focused editable field, automatically open chosen keyboard. On unfocus hide only if opened automatically; manual keyboard stays visible.
- Manual dismiss suppresses repeated open until blur; fixed keyboard button remains usable while zoomed.
- Toggle auto-open under Connection details. Status shows Windows focus received vs not reported.
- iOS build workflow: https://github.com/dansut24/Hi5Central-Platform/actions/runs/43286319977

## Windows Agent isolated focus helper
Branch: `feature/rmm-ios-v0515-focus-state-signal` in `dansut24/Hi5Central-Agent`, based on green v1.0.504 isolated helper.
- Separate `--mode focus-probe` process; never runs UI Automation inside capture/WebRTC.
- Publishes only editable boolean and safe keyboard kind into per-session IPC; never sends text, passwords, selection, URL or window names.
- Service now emits allowlisted `session_state` instead of blocked `remote_focus_state`.
- Agent test build v1.0.505 https://github.com/dansut24/Hi5Central-Agent/actions/runs/43286457827
- **Safety:** helper remains disabled unless `HKLM\SOFTWARE\Hi5Central\Agent\RemoteFocusTrial` DWORD is 1. Start helper only after 5 video frames. Do not automatically deploy the Agent installer or enable the trial fleetwide.
- Once test Agent is installed on Lenovo and streaming baseline rechecked, enable this registry value on that one device for subsequent sessions, then verify focus events.

## Functional test
1. Install iOS native-viewer-only unsigned IPA via Sideloadly; verify remote VP9/H265 video, touch, pan and zoom before enabling focus.
2. Default system iPhone keyboard opens manually and Windows shortcut strip still works (Win, Tab, Esc, Ctrl+A/C/V/X, arrows).
3. Install isolated Agent v1.0.505 only on Lenovo and confirm normal streaming; opt in `RemoteFocusTrial=1` on that single endpoint.
4. Fresh session: click Windows Search, Notepad edit area and Chrome/Edge address bar; verify native iOS keyboard opens automatically, characters type remotely and Backspace/Enter work.
5. Click non-editable desktop: auto-opened keyboard closes. Manually opened keyboard remains.
6. Select Laptop, repeat focus; chosen layout opens. Switch back to iOS; preference persists across sessions.
7. Try text focus across UAC/logon and verify no focus helper launches on secure desktop.
8. If video regresses, disable focus trial and return to known-good Agent v1.0.318; native iOS keyboard remains manually available.

## Limitations and follow-up
- UI Automation detection varies by application; not every third-party editor advertises editability. Keep manual keyboard control.
- Pre-existing focus helper polls at ~350 ms in a separate process; do not call it fully event-driven.
- Agent build/real-device auto-open not verified until test is completed; do not describe as already working.
