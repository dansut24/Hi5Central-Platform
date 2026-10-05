# Hi5Central Viewer

Standalone native Hi5Central remote-session Viewer.

## Platform status

| Platform | Native host | Deep links | Build/package status |
| --- | --- | --- | --- |
| Windows x64 | WebView2 | `hi5central-viewer://` via Inno Setup | Production baseline |
| macOS 12+ (Intel + Apple Silicon) | WKWebView | LaunchServices URL-handler app | CI test build |
| Linux x64 | WebKitGTK 4.1 / GTK 3 | XDG desktop URL handler | CI test build |

The remote-session renderer, signaling contract and WebRTC path are shared across all three platforms. Platform-specific native code is limited to shell integration such as clipboard access, executable/resource discovery, URL activation and Windows-only reserved-key interception.

## Windows

Windows remains the production baseline. The existing Windows build and Inno Setup installer are intentionally unchanged by the macOS/Linux work.

## macOS

The macOS build produces a universal `Hi5CentralViewer.app` containing:

- a lightweight LaunchServices URL-handler executable;
- `Hi5CentralViewerCore`, the existing C++ viewer host;
- the shared HTML/JavaScript viewer resources.

macOS delivers custom URL schemes as application events instead of normal command-line arguments. The launcher receives `hi5central-viewer://`, `hi5viewer://` or `hi5tech://`, starts a fresh viewer-core process with that URL as `argv[1]`, and exits. This keeps the current deep-link/session bootstrap logic intact and permits independent viewer processes for concurrent sessions.

CI applies an ad-hoc signature for test artifacts. Production distribution still requires an Apple Developer ID Application certificate and Apple notarization/stapling.

Logs: `~/Library/Logs/Hi5Central/Viewer/viewer.log`.

## Linux

Development dependencies on Debian/Ubuntu:

```bash
sudo apt install cmake ninja-build g++ libgtk-3-dev libwebkit2gtk-4.1-dev
```

Build:

```bash
cmake -G Ninja -B build -S . -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

The CI artifact contains `Hi5CentralViewer`, the shared `web/` resources, and per-user `install.sh` / `uninstall.sh` scripts. The installer places the viewer under `~/.local/opt/hi5central-viewer` and registers all supported URL schemes with XDG.

Logs: `${XDG_STATE_HOME:-~/.local/state}/hi5central/viewer/viewer.log`.

## Cross-platform behaviour

Core remote display, mouse/keyboard events surfaced by the embedded browser, file-system operations, clipboard bridging, signaling and WebRTC are compiled on macOS and Linux.

Windows still has additional native handling for OS-reserved shortcuts such as Win/Alt combinations and the custom close guard. macOS/Linux reserved system shortcuts and the auxiliary Chat/File Browser native-window behaviour require hands-on desktop validation before those builds should be labelled production-ready.

The Viewer consumes remote-session contracts from Hi5Central Control Server and is versioned independently from the endpoint Agent.
