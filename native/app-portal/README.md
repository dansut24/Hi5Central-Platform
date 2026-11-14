# Hi5Central App Portal

The App Portal is the cross-platform end-user software UI for Hi5Central.

## Architecture

- **UI:** C# / .NET 8 / Avalonia.
- **Privileged endpoint engine:** the existing Hi5Central Agent remains C++.
- **Security boundary:** the UI never receives the Agent secret and never runs elevated.
- **IPC:** platform-specific local broker implementing a shared App Portal protocol.
- **Windows:** named pipe `Hi5CentralAppPortal`.
- **macOS/Linux:** future Unix-domain-socket broker implementations can reuse the same models and UI.

## Windows packaging

The Windows Agent installer publishes the Avalonia project self-contained for `win-x64`,
bundles native/runtime dependencies into a single `Hi5CentralAppPortal.exe`, and stages
that executable beside the C++ Agent binaries before Inno Setup packages the installer.

The portal uses the same local broker contract as the previous native client:
`catalogue` retrieves assigned applications and installation state, while `install`
requests an install or approval flow. All download, validation, elevation and execution
remain inside the privileged Agent/PatchHost path.

## Offline-first App Portal (Windows)

The user-facing Avalonia executable runs independently of the Windows Agent
service. When Agent IPC or cloud is unavailable, the portal shows a clearly
labelled **read-only** last-synchronised catalogue from the signed-in user's
DPAPI-protected LocalAppData cache and a live local uninstall-registry list.
No Agent credentials, package URLs, installation tokens or unsigned approval
rights are cached. No installer or approval request runs without fresh server
authorisation through the Agent. Per-user data is not shared between Windows
profiles. Last catalogue sync is explicit; a cached assignment is not proof of
continued entitlement. When connectivity returns, the portal refreshes.

The **Available to you** view lists current user/device assignments. **Installed**
shows all detectable Windows software (HKLM and current-user HKCU) plus the
latest Agent software inventory; the RMM device Self Service tab shows the
server's per-device detected software and assignment snapshot separately.
