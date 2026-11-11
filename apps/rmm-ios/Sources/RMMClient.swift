import Foundation
import SwiftUI
import WebKit
import UserNotifications

struct ManagedDevice: Identifiable {
    let id: String
    let agentId: String
    let name: String
    let platform: String
    let site: String
    let assignedTo: String
    let lastSeen: String
    let isOnline: Bool
    let hasAgent: Bool
    let cpu: Int?
    let memory: Int?
    let disk: Int?
    let pendingPatches: Int?

    init(_ json: [String: Any]) {
        func string(_ key: String) -> String { (json[key] as? String) ?? "" }
        func number(_ key: String) -> Int? {
            if let n = json[key] as? NSNumber { return n.intValue }
            return nil
        }
        let agent = string("agent_device_id")
        agentId = agent
        id = string("reference").isEmpty ? (agent.isEmpty ? string("id") : agent) : string("reference")
        name = string("name").isEmpty ? "Unnamed device" : string("name")
        platform = string("operating_system").isEmpty ? (string("platform").isEmpty ? "Device" : string("platform")) : string("operating_system")
        site = string("assigned_site_name")
        assignedTo = string("assigned_person_name")
        lastSeen = string("agent_last_telemetry_at")
        hasAgent = !agent.isEmpty
        isOnline = hasAgent && ((json["agent_online"] as? Bool) == true)
        cpu = number("agent_cpu_percent")
        memory = number("agent_memory_used_percent")
        disk = number("agent_disk_used_percent")
        pendingPatches = number("agent_patch_pending_count")
    }

    var status: String {
        hasAgent ? (isOnline ? "Online" : "Offline") : "Inventory only"
    }
}

enum RMMNetworkError: LocalizedError {
    case configuration, unauthorized, server(String), invalidResponse, missingRemoteURL

    var errorDescription: String? {
        switch self {
        case .configuration: return "Enter a valid Hi5Central company prefix."
        case .unauthorized: return "Your session has expired. Sign in again."
        case .server(let message): return message
        case .invalidResponse: return "The server returned an unexpected response."
        case .missingRemoteURL: return "The device did not return a remote viewer URL."
        }
    }
}

@MainActor
final class RMMClient: ObservableObject {
    @Published private(set) var authenticated = false
    @Published private(set) var restored = false
    @Published private(set) var busy = false
    @Published private(set) var userName = ""
    @Published private(set) var companyName = ""
    @Published private(set) var devices: [ManagedDevice] = []
    @Published private(set) var challengeToken: String?
    @Published private(set) var setupSecret: String?
    @Published private(set) var setupURI: String?
    @Published private(set) var recoveryCodes: [String] = []
    @Published var errorMessage: String?
    @Published var alertFeedback: String?
    @Published private(set) var lastUpdated: Date?
    private(set) var tenant = ""

    private let apiBase = URL(string: "https://api.hi5central.com")!

    var offlineDevices: [ManagedDevice] { devices.filter { $0.hasAgent && !$0.isOnline } }
    var onlineCount: Int { devices.filter(\.isOnline).count }
    var installedCount: Int { devices.filter(\.hasAgent).count }
    var needsMFA: Bool { challengeToken != nil }

    func setTenant(_ candidate: String) {
        tenant = candidate
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private func validTenant() -> Bool {
        tenant.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression) != nil
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard validTenant() else { throw RMMNetworkError.configuration }
        guard let url = URL(string: path, relativeTo: apiBase)?.absoluteURL, url.host == apiBase.host,
              url.scheme == "https" else { throw RMMNetworkError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("https://\(tenant)-rmm.hi5central.com", forHTTPHeaderField: "Origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private func perform(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        let request = try request(path, method: method, body: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RMMNetworkError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = json["error"] as? String ?? "Request failed (\(http.statusCode))."
            throw http.statusCode == 401 && path == "/api/v1/auth/session"
                ? RMMNetworkError.unauthorized
                : RMMNetworkError.server(error)
        }
        return json
    }

    private func applySession(_ data: [String: Any]) throws {
        guard (data["authenticated"] as? Bool) == true,
              let tenantData = data["tenant"] as? [String: Any],
              (tenantData["slug"] as? String)?.lowercased() == tenant,
              let access = data["platformAccess"] as? [String: Any],
              (access["rmm"] as? Bool) == true else {
            throw RMMNetworkError.server("This account does not have access to this RMM company.")
        }
        let onboarding = data["onboarding"] as? [String: Any] ?? [:]
        guard onboarding["completedAt"] is String else {
            throw RMMNetworkError.server("Finish company onboarding in Hi5Central before using the app.")
        }
        let user = data["user"] as? [String: Any] ?? [:]
        userName = user["name"] as? String ?? user["email"] as? String ?? "Technician"
        companyName = tenantData["companyName"] as? String ?? tenant
        authenticated = true
        errorMessage = nil
    }

    // Import only Hi5Central session cookies from the old v0.2 WebView when
    // migrating to the native app. Never read localStorage or page content.
    func restore(_ configuredTenant: String) async {
        setTenant(configuredTenant)
        defer { restored = true }
        guard validTenant() else { return }
        let webCookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
        for cookie in webCookies where cookie.name.hasPrefix("hi5central_")
            && cookie.domain.lowercased().hasSuffix("hi5central.com") {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
        do {
            try applySession(await perform("/api/v1/auth/session"))
            await refreshDevices()
        } catch {
            authenticated = false
        }
    }

    func signIn(tenant candidate: String, email: String, password: String) async {
        setTenant(candidate)
        errorMessage = nil
        guard validTenant() else { errorMessage = RMMNetworkError.configuration.localizedDescription; return }
        guard email.contains("@"), !password.isEmpty else {
            errorMessage = "Enter your work email address and password."
            return
        }
        busy = true
        defer { busy = false }
        do {
            HTTPCookieStorage.shared.cookieAcceptPolicy = .always
            let result = try await perform("/api/v1/auth/login-secure", method: "POST", body: [
                "tenantSlug": tenant, "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
                "password": password
            ])
            if (result["mfaRequired"] as? Bool) == true {
                guard let challenge = result["challengeToken"] as? String else {
                    throw RMMNetworkError.invalidResponse
                }
                challengeToken = challenge
                if (result["setupRequired"] as? Bool) == true {
                    try await startMFASetup()
                }
            } else {
                try applySession(await perform("/api/v1/auth/session"))
                await refreshDevices()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func startMFASetup() async throws {
        guard let challengeToken else { throw RMMNetworkError.invalidResponse }
        let result = try await perform("/api/v1/auth/mfa/setup", method: "POST", body: [
            "tenantSlug": tenant, "challengeToken": challengeToken
        ])
        setupSecret = result["secret"] as? String
        setupURI = result["otpauthUri"] as? String
    }

    func verifyMFA(_ code: String) async {
        guard let challengeToken else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let result = try await perform("/api/v1/auth/mfa/verify", method: "POST", body: [
                "tenantSlug": tenant, "challengeToken": challengeToken, "code": code
            ])
            guard (result["authenticated"] as? Bool) == true else { throw RMMNetworkError.invalidResponse }
            try applySession(await perform("/api/v1/auth/session"))
            recoveryCodes = result["recoveryCodes"] as? [String] ?? []
            self.challengeToken = nil
            setupSecret = nil
            setupURI = nil
            await refreshDevices()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func finishRecoveryCodes() { recoveryCodes = [] }

    func cancelMFA() {
        challengeToken = nil
        setupSecret = nil
        setupURI = nil
        errorMessage = nil
    }

    func refreshDevices() async {
        guard authenticated else { return }
        do {
            let result = try await perform("/api/v1/rmm/devices")
            let rows = result["devices"] as? [[String: Any]] ?? []
            devices = rows.map(ManagedDevice.init)
                .sorted { ($0.isOnline && !$1.isOnline) || ($0.isOnline == $1.isOnline && $0.name.localizedStandardCompare($1.name) == .orderedAscending) }
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func openRemote(for device: ManagedDevice) async throws -> URL {
        guard authenticated, device.isOnline, !device.agentId.isEmpty else {
            throw RMMNetworkError.server("This device must be online for remote access.")
        }
        let result = try await perform("/api/v1/rmm/remote-sessions", method: "POST", body: [
            "agentDeviceId": device.agentId, "mode": "console", "viewerClient": "browser"
        ])
        guard let raw = result["browserUrl"] as? String, let url = URL(string: raw),
              url.scheme == "https",
              url.host?.lowercased() == "\(tenant)-rmm.hi5central.com",
              url.path.hasPrefix("/rmm-viewer/") else {
            throw RMMNetworkError.missingRemoteURL
        }
        // The JSON response is authenticated by the same tenant session.
        // Prefer explicit connection ICE credentials if the browser URL's
        // base64url fragment was created without its short-lived TURN entry.
        // No credentials are persisted or written to logs.
        if let connection = result["connection"] as? [String: Any],
           let rows = connection["iceServers"] as? [[String: Any]],
           !rows.isEmpty,
           rows.contains(where: { record in
               let urls = (record["urls"] as? [String]) ??
                   ((record["urls"] as? String).map { [$0] } ?? [])
               return urls.contains { $0.hasPrefix("turn:") || $0.hasPrefix("turns:") } &&
                   !(record["username"] as? String ?? "").isEmpty &&
                   !(record["credential"] as? String ?? "").isEmpty
           }),
           let json = try? JSONSerialization.data(withJSONObject: rows),
           var browser = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let fragment = browser.fragment,
           var params = URLComponents(string: "https://viewer.invalid/?" + fragment) {
            let packed = json.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            var items = params.queryItems ?? []
            items.removeAll { $0.name == "ice" }
            items.append(URLQueryItem(name: "ice", value: packed))
            params.queryItems = items
            browser.percentEncodedFragment = params.percentEncodedQuery
            if let repairedURL = browser.url,
               repairedURL.scheme == url.scheme,
               repairedURL.host == url.host,
               repairedURL.path == url.path {
                return repairedURL
            }
        }
        return url
    }

    // WKWebView and URLSession maintain separate cookie stores. Copy only
    // scoped Hi5Central cookies before starting the existing WebRTC viewer.
    func prepareViewerCookies() async {
        let cookies = HTTPCookieStorage.shared.cookies ?? []
        let trusted = cookies.filter {
            $0.name.hasPrefix("hi5central_") && $0.domain.lowercased().hasSuffix("hi5central.com")
        }
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in trusted {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                store.setCookie(cookie) { continuation.resume() }
            }
        }
    }

    // Native screens use the existing authenticated session and scoped server
    // permissions. New endpoints are deliberately listed here (no arbitrary
    // URL loading or unauthenticated lookups).
    enum NativeResource {
        case patching
        case catalogue(query: String, source: String, page: Int)
        case automations
        case jobs
        case activity
        case remoteSessions
        case trayPolicy

        var path: String {
            switch self {
            case .patching: return "/api/v1/rmm/patching"
            case .catalogue(let query, let source, let page):
                var components = URLComponents()
                components.path = "/api/v1/rmm/patching/catalogue"
                components.queryItems = [
                    URLQueryItem(name: "source", value: source == "winget" ? "winget" : "hi5central"),
                    URLQueryItem(name: "q", value: String(query.prefix(120))),
                    URLQueryItem(name: "page", value: String(max(1, page))),
                    URLQueryItem(name: "pageSize", value: "25")
                ]
                return components.string ?? "/api/v1/rmm/patching/catalogue"
            case .automations: return "/api/v1/rmm/automations"
            case .jobs: return "/api/v1/rmm/jobs?limit=40"
            case .activity: return "/api/v1/rmm/activity?limit=40"
            case .remoteSessions: return "/api/v1/rmm/remote-sessions"
            case .trayPolicy: return "/api/v1/rmm/tray-policy"
            }
        }
    }

    func nativeRead(_ resource: NativeResource) async throws -> [String: Any] {
        guard authenticated else { throw RMMNetworkError.unauthorized }
        return try await perform(resource.path)
    }

    func terminateRemoteSession(id: String) async throws {
        guard UUID(uuidString: id) != nil else { throw RMMNetworkError.invalidResponse }
        _ = try await perform("/api/v1/rmm/remote-sessions/\(id)/terminate",
                              method: "POST", body: [:])
    }

    func executeAutomation(id: String, device: ManagedDevice) async throws {
        guard UUID(uuidString: id) != nil, UUID(uuidString: device.agentId) != nil,
              device.isOnline else {
            throw RMMNetworkError.server("Select an online managed device.")
        }
        _ = try await perform("/api/v1/rmm/automations/\(id)/run", method: "POST",
                              body: ["agentDeviceIds": [device.agentId]])
    }

    func signOut() async {
        _ = try? await perform("/api/v1/auth/logout", method: "POST", body: [:])
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.name.hasPrefix("hi5central_")
            && cookie.domain.lowercased().hasSuffix("hi5central.com") {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        let webCookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        for cookie in webCookies where cookie.name.hasPrefix("hi5central_")
            && cookie.domain.lowercased().hasSuffix("hi5central.com") {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                WKWebsiteDataStore.default().httpCookieStore.delete(cookie) { continuation.resume() }
            }
        }
        authenticated = false
        devices = []
        userName = ""
        companyName = ""
        challengeToken = nil
        setupSecret = nil
        recoveryCodes = []
        errorMessage = nil
    }

    func sendLocalNotificationTest() async {
        alertFeedback = nil
        do {
            let center = UNUserNotificationCenter.current()
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                alertFeedback = "Enable notifications in iPhone Settings to receive test alerts."
                return
            }
            let content = UNMutableNotificationContent()
            content.title = "Hi5Central RMM"
            content.subtitle = "Notification test"
            content.body = "Local alerts are working on your iPhone. Server push will be added with APNs signing."
            content.sound = .default
            content.userInfo = ["kind": "local-test"]
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content,
                 trigger: UNTimeIntervalNotificationTrigger(timeInterval: 8, repeats: false))
            try await center.add(request)
            alertFeedback = "Test alert scheduled for eight seconds. Lock your iPhone to test the Lock Screen."
        } catch {
            alertFeedback = error.localizedDescription
        }
    }
}

// Show local test notifications while the app is open as well as when locked.
final class NativeNotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NativeNotificationPresenter()
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
}
