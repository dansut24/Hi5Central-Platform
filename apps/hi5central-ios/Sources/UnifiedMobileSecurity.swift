import SwiftUI
import LocalAuthentication
import UserNotifications

/// Local app privacy is never a replacement for server sessions, MFA or WebAuthn.
enum UnifiedSecurityRules {
    static func isLocked(tenant: String, settings: String) -> Bool {
        settings.split(separator: ",").contains { String($0) == tenant }
    }
    static func updated(tenant: String, settings: String, enabled: Bool) -> String {
        var tenants = Set(settings.split(separator: ",").map(String.init))
        if enabled { tenants.insert(tenant) } else { tenants.remove(tenant) }
        return tenants.sorted().joined(separator: ",")
    }
}

@MainActor
enum UnifiedDeviceAuthentication {
    static func confirm(_ reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return false
        }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) {
                success, _ in
                continuation.resume(returning: success)
            }
        }
    }
}

struct UnifiedPrivacyLockScreen: View {
    let tenant: String
    let busy: Bool
    let issue: String?
    let unlock: () -> Void
    let signOut: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 60)).foregroundStyle(.tint)
            Text("Hi5Central is locked").font(.title2.bold())
            Text("Unlock your current \(tenant) session with Face ID, Touch ID or your device passcode.")
                .font(.subheadline).multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button(action: unlock) {
                HStack {
                    if busy { ProgressView() }
                    Label("Unlock", systemImage: "faceid")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
            if let issue {
                Text(issue).font(.footnote).foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            Button("Sign out instead", role: .destructive, action: signOut)
            Spacer()
        }
        .padding(26)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}

struct UnifiedPrivacyAndAlertsView: View {
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @AppStorage("hi5central.mobile.lockedTenants") private var lockedTenants = ""
    @AppStorage("hi5central.mobile.foregroundAlerts") private var foregroundAlerts = false
    @State private var issue: String?
    @State private var busy = false

    private var appLockEnabled: Bool {
        UnifiedSecurityRules.isLocked(tenant: auth.tenant, settings: lockedTenants)
    }

    var body: some View {
        List {
            Section {
                Button(appLockEnabled ? "Disable device unlock" : "Enable device unlock") {
                    Task { await changeLock() }
                }
                .disabled(busy)
                LabeledContent("Current company", value: auth.companyName.isEmpty ? auth.tenant : auth.companyName)
            } header: {
                Text("Privacy")
            } footer: {
                Text("Optional Face ID, Touch ID or device passcode protects the open app on return from the background. The server still requires your staff session and MFA. Leaving the app closes any active remote viewer when this lock is enabled.")
            }
            Section {
                Button(foregroundAlerts ? "Disable foreground alerts" : "Enable foreground alerts") {
                    Task { await changeAlerts() }
                }
                .disabled(busy)
                Button("Send a test notification") {
                    Task { await testNotification() }
                }
            } header: {
                Text("iPhone notifications")
            } footer: {
                Text("Opt-in alerts are generated only while this app is running and signed in. Background or closed-app push requires Apple APNs entitlements and a secure server registration/delivery system; it is not active in this sideload build.")
            }
            if let issue {
                Section {
                    Text(issue).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Privacy & alerts")
    }

    private func changeLock() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if await UnifiedDeviceAuthentication.confirm("Confirm changes to your Hi5Central app lock.") {
            lockedTenants = UnifiedSecurityRules.updated(
                tenant: auth.tenant, settings: lockedTenants, enabled: !appLockEnabled)
            issue = appLockEnabled ? "App lock is enabled for this company." :
                "App lock preference updated."
        } else {
            issue = "Device authentication was unavailable or cancelled. No settings were changed."
        }
    }

    private func changeAlerts() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if foregroundAlerts {
            foregroundAlerts = false
            issue = "Foreground alerts disabled."
            return
        }
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            foregroundAlerts = granted
            issue = granted ? "Foreground alerts enabled." :
                "Notifications were not authorised. Review iPhone Settings."
        } catch { issue = error.localizedDescription }
    }

    private func testNotification() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                issue = "Notifications were not authorised in iPhone Settings."
                return
            }
            try await UnifiedLocalNotification.send(
                title: "Hi5Central Mobile", message: "Local notifications are working.",
                url: nil)
            issue = "Test notification submitted to iOS."
        } catch { issue = error.localizedDescription }
    }
}

enum UnifiedLocalNotification {
    static func send(title: String, message: String, url: URL?) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        if let url { content.userInfo = ["deepLink": url.absoluteString] }
        let request = UNNotificationRequest(
            identifier: UUID().uuidString, content: content, trigger: nil)
        try await UNUserNotificationCenter.current().add(request)
    }
}

/// Native alert taps are routed back into the authorised in-app record/device picker.
final class UnifiedNotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = UnifiedNotificationPresenter()
    static let routeNotification = Notification.Name("Hi5CentralMobileNotificationRoute")

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let value = response.notification.request.content.userInfo["deepLink"] as? String,
           let url = URL(string: value), url.scheme?.lowercased() == "hi5central" {
            DispatchQueue.main.async {
                NotificationCenter.default.post(
                    name: Self.routeNotification, object: url)
            }
        }
        completionHandler()
    }
}
