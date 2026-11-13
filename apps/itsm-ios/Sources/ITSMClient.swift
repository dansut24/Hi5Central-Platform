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
    let raw: [String: Any]
    let sla: [String: Any]
    let approvals: [[String: Any]]
    let attachments: [[String: Any]]
    let requestTasks: [[String: Any]]

    init(_ item: [String: Any], isServiceRequest: Bool = false) {
        raw = item
        sla = itsmDict(item["sla"])
        approvals = itsmRows(item["requestApprovals"])
        attachments = itsmRows(item["attachments"])
        requestTasks = itsmRows(item["requestTasks"])
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
    @Published private(set) var people: [[String: Any]] = []
    @Published private(set) var teams: [[String: Any]] = []
    @Published private(set) var departments: [[String: Any]] = []
    @Published private(set) var sites: [[String: Any]] = []
    @Published private(set) var cmdb: [[String: Any]] = []
    @Published private(set) var projects: [[String: Any]] = []
    @Published private(set) var calendar: [[String: Any]] = []
    @Published private(set) var report: [String: Any] = [:]
    @Published private(set) var extraErrors: [String: String] = [:]
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
    private(set) var currentUserId = ""
    private(set) var isAdmin = false
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
        currentUserId = itsmString(user["id"])
        isAdmin = ["owner", "admin"].contains(itsmString(user["tenantRole"]))
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
        async let organisation: Void = refreshOrganisation()
        async let assets: Void = refreshCMDB()
        async let projects: Void = refreshProjects()
        async let calendar: Void = refreshCalendar()
        _ = await (summary, tasks, knowledge, notifications, organisation, assets, projects, calendar)
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

    func refreshOrganisation() async {
        guard authenticated else { return }
        do {
            let json = try await request("/api/v1/organisation")
            people = itsmRows(json["people"])
            teams = itsmRows(json["teams"])
            departments = itsmRows(json["departments"])
            sites = itsmRows(json["sites"])
            extraErrors.removeValue(forKey: "people")
        } catch {
            extraErrors["people"] = error.localizedDescription
        }
    }

    func refreshCMDB() async {
        guard authenticated else { return }
        do {
            let json = try await request("/api/v1/cmdb")
            cmdb = itsmRows(json["items"])
            extraErrors.removeValue(forKey: "cmdb")
        } catch {
            extraErrors["cmdb"] = error.localizedDescription
        }
    }

    func refreshProjects() async {
        guard authenticated else { return }
        do {
            let json = try await request("/api/v1/projects")
            projects = itsmRows(json["items"])
            extraErrors.removeValue(forKey: "projects")
        } catch {
            extraErrors["projects"] = error.localizedDescription
        }
    }

    func refreshCalendar() async {
        guard authenticated else { return }
        do {
            let json = try await request("/api/v1/projects/calendar")
            calendar = itsmRows(json["items"])
            extraErrors.removeValue(forKey: "calendar")
        } catch {
            extraErrors["calendar"] = error.localizedDescription
        }
    }

    func taskDetail(_ id: String) async throws -> [String: Any] {
        try await request("/api/v1/tasks/\(safeReference(id))")
    }

    func taskNote(_ id: String, text: String, customer: Bool = false) async throws {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw ITSMAPIError.invalidResponse }
        _ = try await request("/api/v1/tasks/\(safeReference(id))/notes",
                              method: "POST",
                              body: ["text": clean,
                                     "visibility": customer ? "customer" : "internal"])
        await refreshTasks()
    }

    func taskStatus(_ id: String, status: String,
                    completionNotes: String = "") async throws {
        guard ["Ready", "In Progress", "Blocked", "Completed"].contains(status) else {
            throw ITSMAPIError.invalidResponse
        }
        var payload: [String: Any] = ["status": status]
        if status == "Completed" { payload["completionNotes"] = completionNotes }
        _ = try await request("/api/v1/tasks/\(safeReference(id))",
                              method: "PATCH", body: payload)
        await refreshTasks()
        await refreshRecords()
    }

    func decision(for record: ITSMRecord, approvalId: String,
                  accepted: Bool, note: String) async throws -> ITSMRecord {
        guard record.isServiceRequest,
              UUID(uuidString: approvalId) != nil else {
            throw ITSMAPIError.invalidResponse
        }
        let clean = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !accepted && clean.isEmpty {
            throw ITSMAPIError.forbidden("Enter a reason before rejecting an approval.")
        }
        _ = try await request(
            "/api/v1/service-requests/\(safeReference(record.id))/approvals/\(approvalId)/decision",
            method: "POST",
            body: ["decision": accepted ? "Approved" : "Rejected", "note": clean])
        let updated = try await detail(for: record)
        await refreshRecords()
        return updated
    }

    func projectDetail(_ id: String) async throws -> [String: Any] {
        try await request("/api/v1/projects/\(safeReference(id))")
    }

    func assetDetail(_ reference: String) async throws -> [String: Any] {
        try await request("/api/v1/cmdb/\(safeReference(reference))")
    }

    func articleDetail(_ id: String) async throws -> [String: Any] {
        try await request("/api/v1/knowledge/\(safeReference(id))")
    }

    func detail(for record: ITSMRecord) async throws -> ITSMRecord {
        let encoded = try safeReference(record.id)
        if record.isServiceRequest {
            return ITSMRecord(try await request("/api/v1/service-requests/\(encoded)"),
                              isServiceRequest: true)
        }
        return ITSMRecord(try await request("/api/v1/itsm-records/\(encoded)"))
    }

    func createRecord(type: String, title: String, description: String,
                      priority: String, requesterId: String,
                      team: String, assignee: String, service: String,
                      category: String) async throws -> ITSMRecord {
        guard ["Incident", "Problem", "Change"].contains(type) else {
            throw ITSMAPIError.forbidden("Use the Service Catalogue to create a Service Request.")
        }
        let summary = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard summary.count >= 3, summary.count <= 240 else {
            throw ITSMAPIError.forbidden("Enter a summary between 3 and 240 characters.")
        }
        guard ["Low", "Medium", "High", "Critical"].contains(priority),
              description.count <= 20_000 else {
            throw ITSMAPIError.invalidResponse
        }
        var payload: [String: Any] = [
            "type": type,
            "title": summary,
            "description": description,
            "priority": priority,
            "source": "mobile",
            "service": service,
            "category": category
        ]
        if !requesterId.isEmpty { payload["requesterId"] = requesterId }
        if !team.isEmpty { payload["team"] = team }
        if !assignee.isEmpty && assignee != "Unassigned" { payload["assignee"] = assignee }
        let data = try await request("/api/v1/itsm-records",
                                     method: "POST", body: payload)
        let record = ITSMRecord(data)
        await refreshRecords()
        await refreshReport()
        return record
    }

    func editDetails(_ record: ITSMRecord, title: String,
                     description: String, service: String,
                     category: String) async throws -> ITSMRecord {
        guard !record.isServiceRequest else {
            throw ITSMAPIError.forbidden("Service Requests use separate fulfilment workflows.")
        }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanTitle.count >= 3, cleanTitle.count <= 240,
              description.count <= 20_000 else {
            throw ITSMAPIError.forbidden("Provide a valid summary and description.")
        }
        let updated = try await request("/api/v1/itsm-records/\(safeReference(record.id))",
                                        method: "PATCH",
                                        body: [
                                            "title": cleanTitle,
                                            "description": description,
                                            "service": service,
                                            "category": category
                                        ])
        await refreshRecords()
        return ITSMRecord(updated)
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

    func reassign(_ record: ITSMRecord, team: String? = nil,
                  assignee: String? = nil) async throws -> ITSMRecord {
        guard !record.isServiceRequest else {
            throw ITSMAPIError.forbidden("Service Requests use a separate fulfilment assignment workflow.")
        }
        var fields: [String: Any] = [:]
        if let team { fields["team"] = team }
        if let assignee { fields["assignee"] = assignee }
        guard !fields.isEmpty else { return record }
        let updated = try await request("/api/v1/itsm-records/\(safeReference(record.id))",
                                        method: "PATCH", body: fields)
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

    // MARK: - Service Catalogue and Service Request operations
    // All requests reuse the authenticated tenant session and server-side permissions.

    func mobileServiceCatalogue() async throws -> [[String: Any]] {
        let data = try await request("/api/v1/catalogue")
        return itsmRows(data["items"]).filter { item in
            (item["active"] as? Bool) != false &&
            itsmString(item["kind"]) == "request-form" &&
            itsmString(item["requestType"]) == "Service Request" &&
            itsmString(item["visibility"]) != "hidden"
        }
    }

    func newServiceRequest(itemKey: String, summary: String, details: String,
                           priority: String, values: [String: Any],
                           requesterPersonId: String = "") async throws -> ITSMRecord {
        guard !itemKey.isEmpty,
              summary.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3,
              summary.count <= 240, details.count <= 20_000,
              ["Low","Medium","High","Critical"].contains(priority) else {
            throw ITSMAPIError.forbidden("Enter a valid request summary, description and priority.")
        }
        var body: [String: Any] = [
            "catalogueItemId": itemKey,
            "summary": summary.trimmingCharacters(in: .whitespacesAndNewlines),
            "fields": values,
            "details": ["text": details],
            "urgency": priority
        ]
        if !requesterPersonId.isEmpty { body["requesterPersonId"] = requesterPersonId }
        let created = try await request("/api/v1/service-requests", method: "POST", body: body)
        await refreshRecords()
        return ITSMRecord(created, isServiceRequest: true)
    }

    func postServiceRequestNote(for record: ITSMRecord, body: String,
                                customer: Bool) async throws -> ITSMRecord {
        guard record.isServiceRequest,
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              body.count <= 20_000 else { throw ITSMAPIError.invalidResponse }
        let id = try safeReference(record.id)
        _ = try await request("/api/v1/service-requests/\(id)/activities",
                              method: "POST",
                              body: ["kind": customer ? "customer" : "work", "text": body])
        let updated = try await detail(for: record)
        await refreshRecords()
        return updated
    }

    func updateServiceRequest(_ record: ITSMRecord, priority: String? = nil,
                              team: String? = nil, assignee: String? = nil) async throws -> ITSMRecord {
        guard record.isServiceRequest else { throw ITSMAPIError.invalidResponse }
        var fields: [String: Any] = [:]
        if let priority { fields["priority"] = priority }
        if let team { fields["team"] = team }
        if let assignee { fields["assignee"] = assignee }
        guard !fields.isEmpty else { return record }
        _ = try await request("/api/v1/service-requests/\(safeReference(record.id))",
                              method: "PATCH", body: fields)
        let updated = try await detail(for: record)
        await refreshRecords()
        return updated
    }

    func transitionServiceRequest(_ record: ITSMRecord, to target: String,
                                  values: [String: Any] = [:]) async throws -> ITSMRecord {
        guard record.isServiceRequest else { throw ITSMAPIError.invalidResponse }
        _ = try await request("/api/v1/service-requests/\(safeReference(record.id))/transition",
                              method: "POST", body: [
            "targetStatus": target,
            "values": values
        ])
        let updated = try await detail(for: record)
        await refreshRecords()
        return updated
    }

    func updateServiceRequestTask(_ record: ITSMRecord, taskKey: String,
                                  status: String, completionNotes: String = "") async throws -> ITSMRecord {
        guard record.isServiceRequest,
              ["Ready","In Progress","Completed","Blocked"].contains(status) else {
            throw ITSMAPIError.invalidResponse
        }
        var fields: [String: Any] = ["status": status]
        if status == "Completed" {
            guard !completionNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ITSMAPIError.forbidden("Add task completion notes.")
            }
            fields["completionNotes"] = completionNotes
        }
        _ = try await request(
            "/api/v1/service-requests/\(safeReference(record.id))/tasks/\(safeReference(taskKey))",
            method: "PATCH", body: fields)
        let updated = try await detail(for: record)
        await refreshRecords()
        await refreshTasks()
        return updated
    }

    func uploadServiceRequestAttachment(_ record: ITSMRecord, fileURL: URL,
                                        customer: Bool) async throws -> ITSMRecord {
        guard record.isServiceRequest else { throw ITSMAPIError.invalidResponse }
        let access = fileURL.startAccessingSecurityScopedResource()
        defer { if access { fileURL.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: fileURL)
        guard !data.isEmpty && data.count <= 6 * 1024 * 1024 else {
            throw ITSMAPIError.forbidden("Select a file under 6 MB. Your tenant may enforce a lower limit.")
        }
        let mime = "application/octet-stream"
        _ = try await request(
            "/api/v1/service-requests/\(safeReference(record.id))/attachments",
            method: "POST", body: [
                "fileName": fileURL.lastPathComponent,
                "mimeType": mime,
                "contentBase64": data.base64EncodedString(),
                "visibility": customer ? "customer" : "internal"
            ])
        let updated = try await detail(for: record)
        await refreshRecords()
        return updated
    }

    func downloadServiceRequestAttachment(_ record: ITSMRecord,
                                          attachment: [String: Any]) async throws -> URL {
        guard record.isServiceRequest else { throw ITSMAPIError.invalidResponse }
        try checkTenant()
        let reference = try safeReference(record.id)
        let attachmentId = itsmString(attachment["id"])
        guard UUID(uuidString: attachmentId) != nil else { throw ITSMAPIError.invalidResponse }
        let path = "/api/v1/service-requests/\(reference)/attachments/\(attachmentId)"
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.scheme == "https", url.host == base.host else { throw ITSMAPIError.invalidResponse }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData,
                             timeoutInterval: 45)
        req.httpMethod = "GET"
        req.setValue("https://\(tenant).hi5central.com", forHTTPHeaderField: "Origin")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw ITSMAPIError.forbidden("Unable to download this attachment.")
        }
        guard !data.isEmpty && data.count <= 25 * 1024 * 1024 else {
            throw ITSMAPIError.forbidden("Attachment is empty or too large to export from mobile.")
        }
        let sourceName = itsmString(attachment["fileName"])
        let safeName = sourceName.replacingOccurrences(
            of: #"[^A-Za-z0-9._ -]"#, with: "_", options: .regularExpression)
        let finalName = safeName.isEmpty || safeName == "." || safeName == ".."
            ? "attachment" : safeName
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hi5central-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory,
                                                withIntermediateDirectories: true)
        let target = directory.appendingPathComponent(finalName)
        try data.write(to: target, options: .atomic)
        return target
    }

    /// Clear old tenant state synchronously before a different company signs in.
    func clearLocalSession() {
        authenticated = false
        records = []
        tasks = []
        articles = []
        notifications = []
        people = []
        teams = []
        departments = []
        sites = []
        cmdb = []
        projects = []
        calendar = []
        report = [:]
        extraErrors = [:]
        currentUserId = ""
        companyName = ""
        userName = ""
        challenge = nil
        setupSecret = nil
        setupURI = nil
        recoveryCodes = []
        tenant = ""
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
        people = []
        teams = []
        departments = []
        sites = []
        cmdb = []
        projects = []
        calendar = []
        currentUserId = ""
        isAdmin = false
        extraErrors = [:]
        HTTPCookieStorage.shared.removeCookies(since: Date(timeIntervalSince1970: 0))
    }
}
