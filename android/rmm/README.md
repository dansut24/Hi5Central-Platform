# Hi5Central RMM Android

Android Studio project for Hi5Central RMM technicians. The app opens the tenant RMM portal in an Android WebView and renders `window.open`-based remote sessions in an **in-app** second WebView using the existing browser viewer (`/rmm-viewer/index.html`). It uses Hi5Central's existing API, MFA, permissions and WebRTC transport. No Agent or second RMM backend is required.

## Windows development

1. Install Android Studio from https://developer.android.com/studio (Android SDK 35; JDK 17 included).
2. Choose **Open**, then select `android/rmm` inside the Hi5Central-Platform repository.
3. Let Gradle sync. Use an emulator with Google Play or a physical Android device (Android 8+).
4. Run the `app` configuration; provide your tenant slug, e.g. `newtest`, at first launch.
5. For a debug APK: **Build > Build Bundle(s) / APK(s) > Build APK(s)**. Android Studio will produce `app/build/outputs/apk/debug/app-debug.apk`.

The GitHub Actions workflow `android-rmm.yml` also builds an unsigned-for-distribution **debug-signed** APK and uploads it as a test artifact. Do not publish a debug APK as a production release. A release requires a controlled signing key and final mobile testing.

## How remote viewing works

- Native WebView loads `https://{tenant}-rmm.hi5central.com`.
- The current RMM frontend already detects Android as `viewerClient=browser`.
- The API returns an authorized `browserUrl` at the tenant's `/rmm-viewer/index.html#...` route.
- The frontend opens that URL via `window.open`; the Android `WebChromeClient` creates a second, internal WebView on top of the portal.
- Back closes the viewer and returns to the portal. WebRTC's existing codec selection, signaling and input controls remain in the shared viewer code.

## Native Android keyboard (new)

While a remote session is open inside the APK, use **⌨ Type** (floating button near the lower-right edge) after tapping the remote application's text field. This opens the phone's normal Android keyboard. Edits are forwarded live over the existing authenticated viewer input channel; Enter and Backspace buttons are available when the IME does not expose those keys. **Hide** restores the video view without ending the remote session. The existing web remote keyboard remains available for Ctrl, Alt, Windows/Super, function keys and other special shortcuts.

This adapter is active only for the selected tenant's exact HTTPS `/rmm-viewer/index.html` URL. It does not expose a JavaScript bridge to arbitrary websites. On an actual Android phone, the phone's installed Android keyboard is used; an iPhone controlling an Android emulator through Chrome Remote Desktop is a separate input-translation layer.

Confirm that typing, deletion, Enter, special shortcuts, landscape and leaving/rejoining a viewer all work on physical Android hardware before releasing.

## Notifications status

The APK includes a FirebaseMessagingService, notification channel and Android notification permission. **Live push notifications are not yet enabled.** They require the Firebase Android app `com.hi5central.rmm` configuration file (`app/google-services.json`, excluded from Git), secure token registration on the tenant-authenticated Hi5Central API, server-side dispatch for device/alert events, and end-to-end checks. Never embed Firebase service-account credentials in the APK.

## Validation required

- Portal login/MFA, back navigation and change workspace.
- Console and Connect sessions both opening inside the app, including session closure.
- Input handling, landscape, pinch-to-zoom, fullscreen, H.264/H.265/VP8/VP9/AV1 behavior on real Android phones.
- Push token registration, per-tenant targeting, logout/session revocation and deep links once server-side FCM integration is implemented.

The Android app does not provide an endpoint Agent. It is a technician console/viewer.
