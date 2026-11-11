# Hi5Central RMM native iOS — v0.3 test

This is a SwiftUI-native application for Hi5Central RMM, developed on Windows and compiled on macOS GitHub Actions runners.

## Implemented
- Branded full-screen storyboard and animated SwiftUI launch experience.
- Native login form for tenant prefix, email and password against the **existing** `/api/v1/auth/login-secure` API; no password storage.
- Existing mandatory MFA challenge, authenticator setup and one-time recovery-code display.
- Existing session restoration and tenant/RMM access validation.
- Native dashboard, device inventory, search, details and connectivity alerts via `/api/v1/rmm/devices`.
- Native remote launch from an online managed device using `/api/v1/rmm/remote-sessions` and the existing WebRTC Viewer.
- Session cookie handoff between URLSession and the Viewer WKWebView, without logging session tokens.
- Native More panel and remaining advanced RMM pages via the already-working authenticated WebView as migration continues.
- User-triggered **local** iOS notification demonstration after permission grant, including lock-screen/sound support.

## Not yet implemented
- Passkey authentication registration and WebAuthn relying-party support on server.
- APNs push token registration, server-sent background notifications, and push management.
- Fully native screens for the RMM tool suite (Patching, Software, Reports, Automation, Settings, Connect). These currently use the existing secure website inside the app.
- Microsoft SSO login from the native form. Accounts relying on Microsoft SSO require a dedicated ASWebAuthenticationSession integration.

## Windows test install
1. Go to the latest **RMM iOS unsigned IPA** GitHub Actions run for this branch.
2. Open **Artifacts > Hi5CentralRMM-iOS-unsigned**, download and extract the ZIP.
3. Install the unsigned IPA with Sideloadly on Windows using your own Apple ID and trusted iPhone USB connection. Free signing typically needs renewal every seven days.
4. Launch the native login, sign in with tenant/email/password, verify MFA. Sign-in does **not** require or bypass MFA.
5. Refresh Devices; open an online device; tap **Start remote desktop**; verify viewer, mouse, keyboard, zoom, disconnect.
6. Open More > **Send test notification**; allow notifications; lock phone; the locally scheduled alert should appear after about eight seconds.
7. Check navigation and the advanced web-supported tools.

Apple Developer Program membership is **not** required for local notifications, but native remote APNs notifications require a correctly provisioned signed application. A Safari Home Screen PWA can separately use standards-based Web Push without Apple membership; that is not the same install as this IPA.

## Security
- Only `api.hi5central.com` HTTPS API and tenant-matching HTTPS Viewer URLs are used for login and remote launch.
- RMM sessions are created exclusively by existing backend permissions and MFA.
- No viewer session token is saved to preferences, log output, or analytics.
- Mobile credential login uses the existing secure origin/tenant policy and persistent scoped secure session cookies.
- The native device availability screen derives offline state from the inventory; it is not yet an equivalent to the full RMM monitoring rules.
