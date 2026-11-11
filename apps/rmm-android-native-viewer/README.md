# Hi5Central native Android WebRTC viewer

This is an independent Android **library module** intended to be added to the existing Hi5Central RMM Android Studio project. It does **not** replace the APK project or publish any new agent/backend services.

## Protocol

The session launch URL returned by `POST /api/v1/rmm/remote-sessions` has `#session_id=...&device_id=...&token=...&wss_url=...&ice=...`. The sensitive fragment is parsed in memory, not logged or persisted.

- Native WebRTC: `org.webrtc.PeerConnection` with SDP `webrtc_offer`/`webrtc_answer` and `ice_candidate` over the existing authenticated `/viewer/ws` signalling endpoint.
- Native video: `SurfaceViewRenderer` using EGL.
- Remote mouse/keyboard: `input_event` via an open WebRTC data channel, with authorised signalling fallback.
- Chat: `chat_message` over the existing session websocket.
- Files: `remote_file_list_request` / `remote_file_download_request`, with a native document-save picker for received downloads.
- On closing, the caller must terminate its authorised backend session via the existing API (in addition to closing the WebRTC transport).

## Integration

Add the module to the Android app's Gradle settings, include the local library as a dependency, and start:

```kotlin
startActivity(Intent(this, NativeViewerActivity::class.java)
    .putExtra(NativeViewerActivity.EXTRA_VIEWER_URL, browserUrl))
```

Only use `browserUrl` freshly returned from the authenticated Hi5Central session API. Do not share or store it.

## Development build

```bash
gradle :viewer:assembleDebug
```

The Android library is not an installable APK by itself. The pre-existing Android app needs to integrate this module and expose its entry point. This native implementation must be tested on an actual phone; compilation alone does not verify live WebRTC or every codec.

## Current scope

Native viewer video, basic tap/keyboard input, chat and file browsing/download are part of this module. Advanced file uploads, remote monitor controls, image scaling, reconnect resilience and foreground-service handling will need further parity testing. Both iOS and Android use the same remote-session server protocol.
