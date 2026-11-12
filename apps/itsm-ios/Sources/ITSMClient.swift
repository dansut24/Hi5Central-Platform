import Foundation
import SwiftUI

func itsmString(_ value: Any?) -> String {
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return ""
}

func itsmDict(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
func itsmRows(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }

func itsmDate(_ value: String) -> String {
    guard !value.isEmpty else { return "Not recorded" }
    let date = ISO8601DateFormatter().date(from: value)
        ?? ISO8601DateFormatter().date(from: String(value.prefix(19)) + "Z")
    guard let date else { return value }
    return date.formatted(.dateTime.day().month(.abbreviated).year().hour().minute())
}

struct ITSMRecord: Identifiable {
    let id: String
    let type: String
    let title: String
    let status: String
    let priority: String
    let requester: String
    let team: String
    let assignee: String
    let service: String
    let category: String
    let description: String
    let createdAt: String
    let updatedAt: String
    let activities: [[String: Any]]
    let isServiceRequest: Bool

    init(_ item: [String: Any], isServiceRequest: Bool = false) {
        id = itsmString(item["id"]).isEmpty ? itsmString(item["reference"]) : itsmString(item["id"])
        type = isServiceRequest ? "Service Request" : itsmString(item["type"])
        title = itsmString(item["title"])
        status = itsmString(item["status"])
        priority = itsmString(item["priority"])
        requester = itsmString(item["requester"])
        team = itsmString(item["team"])
        assignee = itsmString(item["assignee"])
        service = itsmString(item["service"])
        category = itsmString(item["category"])
        description = itsmString(item["description"])
        createdAt = itsmString(item["createdAt"])
        updatedAt = itsmString(item["updatedAt"])
        activities = itsmRows(item["activities"])
        self.isServiceRequest = isServiceRequest
    }

    var isOpen: Bool {
        !["Resolved", "Closed", "Completed", "Complete", "Cancelled", "Rejected"]
            .contains(status)
    }
}

struct ITSMTask: Identifiable {
    let id: String
    let title: String
    let status: String
    let reference: String
    let assignedTo: String

    init(_ row: [String: Any]) {
        id = itsmString(row["id"]).isEmpty
            ? itsmString(row["external_key"]) : itsmString(row["id"])
        title = itsmString(row["title"])
        status = itsmString(row["status"])
        reference = itsmString(row["requestReference"]).isEmpty
            ? (itsmString(row["record_reference"]).isEmpty
                ? itsmString(row["reference"]) : itsmString(row["record_reference"]))
            : itsmString(row["requestReference"])
        assignedTo = itsmString(row["assignee"])
    }
}

struct ITSMArticle: Identifiable {
    let id: String
    let title: String
    let summary: String
    let category: String
    let status: String
    let body: String

    init(_ row: [String: Any]) {
        id = itsmString(row["reference"]).isEmpty
            ? itsmString(row["slug"]) : itsmString(row["reference"])
        title = itsmString(row["title"])
        summary = itsmString(row["summary"])
        category = itsmString(row["category"])
        status = itsmString(row["status"])
        body = itsmString(row["bodyText"]).isEmpty
            ? itsmString(row["body_text"]) : itsmString(row["bodyText"])
    }
}

enum ITSMAPIError: LocalizedError {
    case invalidTenant, invalidResponse, forbidden(String), notAuthenticated, network(String)
    var errorDescription: String? {
        switch self {
        case .invalidTenant: return "Enter a valid Hi5Central company prefix."
        case .invalidResponse: return "Hi5Central returned an unexpected response."
        case .forbidden(let reason): return reason
        case .notAuthenticated: return "Your session has expired. Sign in again."
        case .network(let reason): return reason
        }
    }
}

/// Uses the exact existing staff-session, mandatory MFA and tenant origin
/// checks. Credentials are never persisted. All reads/writes go through
/// tenant-scoped APIs, not a WebView or a new unaudited RMM channel.
@MainActor
final class ITSMClient: ObservableObject {
    @Published private(set) var authenticated = false
    @Published private(set) var busy = false
    @Published private(set) var companyName = ""
    @Published private(set) var userName = ""
    @Published private(set) var records: [ITSMRecord] = []
    @Published private(set) var tasks: [ITSMTask] = []
    @Published private(set) var articles: [ITSMArticle] = []
    @Published private(set) var notifications: [[String: Any]] = []
    @Published private(set) var report: [String: Any] = [:]
    @Published private(set) var challenge: String?
    @Published private(set) var setupSecret: String?
    @Published private(set) var setupURI: String?
    @Published private(set) var recoveryCodes: [String] = []
    @Published var errorMessage: String?
    @Published var recordsMessage: String?
    @Published var tasksMessage: String?
    @Published var knowledgeMessage: String?
    @Published private(set) var lastRefreshed: Date?

    private(set) var tenant = ""
    private let base = URL(string: "https://api.hi5central.com")!

    func setTenant(_ raw: String) {
        tenant = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func checkTenant() throws {
        guard tenant.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#,
                           options: .regularExpression) != nil else {
            throw ITSMAPIError.invalidTenant
        }
    }

    private func request(_ path: String, method: String = "GET",
                         body: [String: Any]? = nil) async throws -> [String: Any] {
        try checkTenant()
        guard path.hasPrefix("/api/v1/"),
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.scheme == "https", url.host == base.host else {
            throw ITSMAPIError.invalidResponse
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData,
                             timeoutInterval: 25)
        req.httpMethod = method
        req.setValue("https://\(tenant).hi5central.com", forHTTPHeaderField: "Origin")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ITSMAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw ITSMAPIError.notAuthenticated }
        guard (200..<300).contains(http.statusCode) else {
            throw ITSMAPIError.forbidden(itsmString(json["error"]).isEmpty
                ? "Request failed (HTTP \(http.statusCode))." : itsmString(json["error"]))
        }
        return json
    }

    private func applySession(_ json: [String: Any]) throws {
        let platform = itsmDict(json["platformAccess"])
        let user = itsmDict(json["user"])
        let company = itsmDict(json["tenant"])
        let access = itsmDict(json["access"])
        guard (json["authenticated"] as? Bool) == true,
              (platform["itsm"] as? Bool) == true,
              (access["workspaceAccess"] as? Bool) == true,
              itsmString(company["slug"]).lowercased() == tenant,
              itsmString(user["tenantRole"]) != "requester" else {
            throw ITSMAPIError.forbidden("This account does not have staff access to Hi5Central ITSM.")
        }
        let onboarding = itsmDict(json["onboarding"])
        guard !itsmString(onboarding["completedAt"]).isEmpty else {
            throw ITSMAPIError.forbidden("Complete Hi5Central onboarding in your browser first.")
        }
        companyName = itsmString(company["companyName"])
        userName = itsmString(user["name"]).isEmpty
            ? itsmString(user["email"]) : itsmString(user["name"])
        authenticated = true
        errorMessage = nil
    }

    func restore(_ slug: String) async {
        setTenant(slug)
        guard !tenant.isEmpty else { return }
        do {
            try applySession(try await request("/api/v1/auth/session"))
            await refreshAll()
        } catch {
            authenticated = false
        }
    }

    func signIn(tenant: String, email: String, password: String) async {
        setTenant(tenant)
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            HTTPCookieStorage.shared.cookieAcceptPolicy = .always
            let data = try await request("/api/v1/auth/login-secure",
                                         method: "POST",
                                         body: ["tenantSlug": self.tenant,
                                                "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
                                                "password": password])
            if data["mfaRequired"] as? Bool == true {
                guard let token = data["challengeToken"] as? String else {
                    throw ITSMAPIError.invalidResponse
                }
                challenge = token
                if data["setupRequired"] as? Bool == true {
                    try await beginMFASetup()
                }
            } else {
                try applySession(try await request("/api/v1/auth/session"))
                await refreshAll()
            }
        } catch { errorMessage = error.localizedDescription }
    }

    func beginMFASetup() async throws {
        guard let challenge else { throw ITSMAPIError.invalidResponse }
        let data = try await request("/api/v1/auth/mfa/setup",
                                     method: "POST",
                                     body: ["tenantSlug": tenant, "challengeToken": challenge])
        setupSecret = data["secret"] as? String
        setupURI = data["otpauthUri"] as? String
    }

    func verifyMFA(_ code: String) async {
        guard let challenge else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let result = try await request("/api/v1/auth/mfa/verify",
                                           method: "POST",
                                           body: ["tenantSlug": tenant,
                                                  "challengeToken": challenge,
                                                  "code": code])
            guard (result["authenticated"] as? Bool) == true else {
                throw ITSMAPIError.invalidResponse
            }
            try applySession(try await request("/api/v1/auth/session"))
            recoveryCodes = result["recoveryCodes"] as? [String] ?? []
            self.challenge = nil
            setupSecret = nil
            setupURI = nil
            await refreshAll()
        } catch { errorMessage = error.localizedDescription }
    }

    func cancelMFA() {
        challenge = nil
        setupSecret = nil
        setupURI = nil
        errorMessage = nil
    }

    func clearRecoveryCodes() { recoveryCodes = [] }

    func refreshAll() async {
        await refreshRecords()
        async let summary: Void = refreshReport()
        async let tasks: Void = refreshTasks()
        async let knowledge: Void = refreshKnowledge()
        async let notifications: Void = refreshNotifications()
        _ = await (summary, tasks, knowledge, notifications)
    }

    func refreshRecords() async {
        guard authenticated else { return }
        var collected: [ITSMRecord] = []
        var errors: [String] = []
        do {
            let json = try await request("/api/v1/itsm-records?limit=200")
            collected += itsmRows(json["items"]).map { ITSMRecord($0) }
        } catch {
            // Some staff roles can view specific record types but not view_all.
            for type in ["Incident", "Problem", "Change"] {
                let encoded = type.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? type
                if let json = try? await request("/api/v1/itsm-records?type=\(encoded)&limit=200") {
                    collected += itsmRows(json["items"]).map { ITSMRecord($0) }
                }
            }
            if collected.isEmpty { errors.append("Unable to load incidents, problems and changes.") }
        }
        do {
            let json = try await request("/api/v1/service-requests?limit=200")
            collected += itsmRows(json["items"]).map { ITSMRecord($0, isServiceRequest: true) }
        } catch { errors.append("Service requests unavailable: \(error.localizedDescription)") }

        let unique = Dictionary(grouping: collected, by: \.id)
            .compactMap { $0.value.first }
        records = unique.sorted { $0.updatedAt > $1.updatedAt }
        recordsMessage = errors.isEmpty ? nil : errors.joined(separator: " ")
        lastRefreshed = Date()
    }

    func refreshReport() async {
        guard authenticated else { return }
        do {
            report = try await request("/api/v1/itsm/reports/summary")
        } catch {
            // Dashboard numbers may be withheld by the Reports permission.
            // Never pretend a subset of records is a complete fleet total.
            report = [:]
        }
    }

    func refreshTasks() async {
        guard authenticated else { return }
        do {
            let data = try await request("/api/v1/tasks?limit=100")
            tasks = itsmRows(data["items"]).map(ITSMTask.init)
            tasksMessage = nil
        } catch { tasksMessage = error.localizedDescription }
    }

    func refreshKnowledge() async {
        guard authenticated else { return }
        do {
            let data = try await request("/api/v1/knowledge")
            articles = itsmRows(data["items"]).map(ITSMArticle.init)
            knowledgeMessage = nil
        } catch { knowledgeMessage = error.localizedDescription }
    }

    func refreshNotifications() async {
        guard authenticated else { return }
        if let data = try? await request("/api/v1/notifications?limit=60") {
            notifications = itsmRows(data["items"])
        }
    }

    func detail(for record: ITSMRecord) async throws -> ITSMRecord {
        let encoded = try safeReference(record.id)
        if record.isServiceRequest {
            return ITSMRecord(try await request("/api/v1/service-requests/\(encoded)"),
                              isServiceRequest: true)
        }
        return ITSMRecord(try await request("/api/v1/itsm-records/\(encoded)"))
    }

    func postNote(for record: ITSMRecord, body: String,
                  customer: Bool) async throws -> ITSMRecord {
        guard !record.isServiceRequest else {
            throw ITSMAPIError.forbidden("Service Request comments will be added after its workflow API is verified.")
        }
        let encoded = try safeReference(record.id)
        let data = try await request("/api/v1/itsm-records/\(encoded)/activities",
                                     method: "POST",
                                     body: ["kind": customer ? "customer" : "work", "text": body])
        await refreshRecords()
        return ITSMRecord(data)
    }

    func update(_ record: ITSMRecord, status: String?,
                priority: String?) async throws -> ITSMRecord {
        guard !record.isServiceRequest else {
            throw ITSMAPIError.forbidden("Service Requests use a separate fulfilment workflow.")
        }
        var payload: [String: Any] = [:]
        if let status { payload["status"] = status }
        if let priority { payload["priority"] = priority }
        guard !payload.isEmpty else { return record }
        let encoded = try safeReference(record.id)
        let updated = try await request("/api/v1/itsm-records/\(encoded)",
                                        method: "PATCH", body: payload)
        await refreshRecords()
        return ITSMRecord(updated)
    }

    func markNotificationRead(_ item: [String: Any]) async {
        let id = itsmString(item["id"])
        guard UUID(uuidString: id) != nil else { return }
        _ = try? await request("/api/v1/notifications/\(id)/read",
                               method: "POST", body: [:])
        await refreshNotifications()
    }

    private func safeReference(_ key: String) throws -> String {
        guard !key.isEmpty,
              key.range(of: #"^[A-Za-z0-9-]{1,80}$"#,
                        options: .regularExpression) != nil else {
            throw ITSMAPIError.invalidResponse
        }
        return key
    }

    func signOut() async {
        _ = try? await request("/api/v1/auth/logout", method: "POST", body: [:])
        authenticated = false
        challenge = nil
        setupSecret = nil
        setupURI = nil
        recoveryCodes = []
        records = []
        tasks = []
        articles = []
        notifications = []
        report = [:]
        HTTPCookieStorage.shared.removeCookies(since: Date(timeIntervalSince1970: 0))
    }
}
