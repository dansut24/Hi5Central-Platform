import Foundation
import SwiftUI

/// One tenant-bound authenticated session for the combined app.
/// The session payload, not a local preference, controls both modules.
@MainActor
final class UnifiedMobileAuth: ObservableObject {
    @Published private(set) var authenticated = false
    @Published private(set) var busy = false
    @Published private(set) var tenant = ""
    @Published private(set) var companyName = ""
    @Published private(set) var userName = ""
    @Published private(set) var hasITSM = false
    @Published private(set) var hasRMM = false
    @Published private(set) var challengeToken: String?
    @Published private(set) var setupSecret: String?
    @Published private(set) var setupURI: String?
    @Published private(set) var recoveryCodes: [String] = []
    @Published var errorMessage: String?

    private let host = URL(string: "https://api.hi5central.com")!

    private func validateTenant(_ value: String) throws -> String {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard clean.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#,
                          options: .regularExpression) != nil else {
            throw ITSMAPIError.invalidTenant
        }
        return clean
    }

    private func request(_ path: String, method: String = "GET",
                         body: [String: Any]? = nil) async throws -> [String: Any] {
        guard path.hasPrefix("/api/v1/auth/"),
              let url = URL(string: path, relativeTo: host)?.absoluteURL,
              url.host == host.host, url.scheme == "https" else {
            throw ITSMAPIError.invalidResponse
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: 25)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("https://\(tenant).hi5central.com", forHTTPHeaderField: "Origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ITSMAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw ITSMAPIError.notAuthenticated }
        guard (200..<300).contains(http.statusCode) else {
            throw ITSMAPIError.forbidden(
                itsmString(json["error"]).isEmpty
                ? "Request failed (HTTP \(http.statusCode))."
                : itsmString(json["error"])
            )
        }
        return json
    }

    private func acceptSession(_ json: [String: Any]) throws {
        let platform = itsmDict(json["platformAccess"])
        let access = itsmDict(json["access"])
        let tenantData = itsmDict(json["tenant"])
        let user = itsmDict(json["user"])
        let onboarding = itsmDict(json["onboarding"])
        guard (json["authenticated"] as? Bool) == true,
              itsmString(tenantData["slug"]).lowercased() == tenant,
              itsmString(user["tenantRole"]) != "requester",
              !itsmString(onboarding["completedAt"]).isEmpty else {
            throw ITSMAPIError.forbidden("This account is not authorised for a Hi5Central staff app.")
        }
        let itsm = (platform["itsm"] as? Bool == true)
            && (access["workspaceAccess"] as? Bool == true)
        let rmm = platform["rmm"] as? Bool == true
        guard itsm || rmm else {
            throw ITSMAPIError.forbidden("No ITSM or RMM workspace is enabled for your account.")
        }
        hasITSM = itsm
        hasRMM = rmm
        companyName = itsmString(tenantData["companyName"])
        userName = itsmString(user["name"]).isEmpty
            ? itsmString(user["email"]) : itsmString(user["name"])
        authenticated = true
        errorMessage = nil
    }

    func restore(_ configuredTenant: String) async {
        guard let validated = try? validateTenant(configuredTenant) else { return }
        tenant = validated
        do {
            try acceptSession(try await request("/api/v1/auth/session"))
        } catch {
            authenticated = false
            hasITSM = false
            hasRMM = false
        }
    }

    func signIn(tenant value: String, email: String, password: String) async {
        busy = true
        defer { busy = false }
        errorMessage = nil
        do {
            tenant = try validateTenant(value)
            guard email.contains("@"), !password.isEmpty else {
                throw ITSMAPIError.forbidden("Enter a work email and password.")
            }
            HTTPCookieStorage.shared.cookieAcceptPolicy = .always
            let payload = try await request("/api/v1/auth/login-secure", method: "POST",
                body: ["tenantSlug": tenant,
                       "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
                       "password": password])
            if payload["mfaRequired"] as? Bool == true {
                guard let token = payload["challengeToken"] as? String else {
                    throw ITSMAPIError.invalidResponse
                }
                challengeToken = token
                if payload["setupRequired"] as? Bool == true {
                    try await beginMFASetup()
                }
            } else {
                try acceptSession(try await request("/api/v1/auth/session"))
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func beginMFASetup() async throws {
        guard let token = challengeToken else { throw ITSMAPIError.invalidResponse }
        let payload = try await request("/api/v1/auth/mfa/setup", method: "POST",
            body: ["tenantSlug": tenant, "challengeToken": token])
        setupSecret = payload["secret"] as? String
        setupURI = payload["otpauthUri"] as? String
    }

    func verify(_ code: String) async {
        guard let token = challengeToken else { return }
        busy = true
        defer { busy = false }
        errorMessage = nil
        do {
            let result = try await request("/api/v1/auth/mfa/verify", method: "POST",
                body: ["tenantSlug": tenant, "challengeToken": token,
                       "code": code.trimmingCharacters(in: .whitespacesAndNewlines)])
            guard result["authenticated"] as? Bool == true else {
                throw ITSMAPIError.invalidResponse
            }
            try acceptSession(try await request("/api/v1/auth/session"))
            recoveryCodes = result["recoveryCodes"] as? [String] ?? []
            challengeToken = nil
            setupSecret = nil
            setupURI = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func cancelMFA() {
        challengeToken = nil
        setupSecret = nil
        setupURI = nil
        errorMessage = nil
    }

    func clearRecoveryCodes() { recoveryCodes = [] }

    func signOut() async {
        _ = try? await request("/api/v1/auth/logout", method: "POST", body: [:])
        authenticated = false
        hasITSM = false
        hasRMM = false
        companyName = ""
        userName = ""
        challengeToken = nil
        setupSecret = nil
        setupURI = nil
        recoveryCodes = []
        HTTPCookieStorage.shared.removeCookies(since: Date(timeIntervalSince1970: 0))
    }
}
