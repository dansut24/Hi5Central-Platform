# Hi5Central RMM for iOS — native test build

This project creates a **real SwiftUI iPhone/iPad app**, with a native mobile
shell around the existing Hi5Central RMM tenant portal. The current browser
viewer is hosted in a separate in-app WKWebView for live WebRTC sessions.

## Phase 1: what works in source

- Onboarding accepts an RMM tenant prefix, for example `newtest`, then loads
  `https://newtest-rmm.hi5central.com` over HTTPS.
- Native top bar, bottom navigation (Home / Devices / Alerts / More),
  additional shortcuts (Patching / Software / Automation / Reports / Settings).
- Loads the existing RMM login, MFA, device management and alerts pages; cookies
  persist in the normal WKWebView website data store.
- Captures browser Viewer popups and presents the Viewer **in-app**, sharing
  the same cookie store. Viewer gets existing mobile text, keyboard and touch UI.
- Native Type button attempts to focus the existing viewer text field; on iOS,
  keyboard appearance from programmatic focus must be verified on a real phone.
- Native Disconnect closes through the existing Viewer disconnect button.
- No new unauthenticated RMM endpoints, trusted-certificate bypass, or custom
  JavaScript forwarding of session credentials.

The *contents* of the portal pages are still web UI. A fully native device list,
monitoring dashboard and native push notifications are **not implemented** yet.

## Building for iPhone on Windows (no Mac required)

GitHub Actions starts when files in this directory or the iOS workflow change.
Open the **RMM iOS unsigned IPA** workflow in GitHub Actions and inspect its
latest successful run. Download the `Hi5CentralRMM-iOS-unsigned` artifact,
extract the ZIP and locate `Hi5CentralRMM-unsigned.ipa`.

This file is deliberately **unsigned**. **You cannot simply download and open
this IPA in Safari** on a standard iPhone. To test without jailbreaking:
1. Install Sideloadly on Windows.
2. Connect the iPhone with a trusted USB cable; allow device trust prompts.
3. Select the unsigned IPA in Sideloadly and sign/install with a free Apple ID.
4. Enable Developer Mode / trust the local developer identity if iOS asks.
5. Repeat signing regularly (free personal signing normally lasts 7 days).

Sideloadly compatibility with the unsigned bundle must be validated with a real
device; an unsigned GitHub artifact alone is not proof of installation success.
A paid Apple Developer membership and suitable distribution signing are required
for Ad Hoc or TestFlight distribution.

## If you have a Mac later

```bash
brew install xcodegen
cd apps/rmm-ios
xcodegen generate --spec project.yml
open Hi5CentralRMM.xcodeproj
```

## Manual smoke tests

1. Set up a test tenant and sign in with existing credentials and MFA.
2. Open Devices, Alerts and a device detail page.
3. Start a remote session from an online agent — verify it opens **inside** app.
4. Verify VP8 / H.264 / H.265 receive as supported by iOS WKWebView.
5. Test remote mouse/touch, native iPhone keyboard, zoom/pan, CAD and reconnect.
6. Disconnect; verify the session terminates and a new one can start.
7. Switch between tabs, rotate the phone and relaunch (cookies still valid).
8. Check SSO login and link-popup behaviour; external identity providers may
   require ASWebAuthenticationSession in a later release.

## Android parity

Mirror the native navigation and viewer overlay in the existing Android app,
using the same tenant URL and RMM routes. **Do not copy iOS WKWebView APIs into
Android**; keep Android's WebView/WebRTC and keyboard input handling native.

## Security and constraints

- HTTPS-only Hi5Central domain allowlist; URLs from unrelated domains open via
  the system browser only when HTTPS.
- In-app remote Viewer links are restricted to trusted Hi5Central viewer paths.
- The Viewer may carry a single-use session token in its URL fragment: **never
  log, persist, share, or send the full launch URL to analytics**.
- Existing backend session authorization, audit and MFA are unchanged.
- This first build is a test preview, not App Store production readiness.
