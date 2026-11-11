import Foundation
import SwiftUI

enum RMMRoute: String, CaseIterable, Identifiable {
    case dashboard, devices, alerts, patching, software, automation, reports, settings, profile, connect

    var id: String { rawValue }
    var path: String { self == .dashboard ? "/" : "/\(rawValue)" }
    var title: String {
        switch self {
        case .dashboard: return "Overview"
        case .devices: return "Devices"
        case .alerts: return "Alerts"
        case .patching: return "Patching"
        case .software: return "Software"
        case .automation: return "Automation"
        case .reports: return "Reports"
        case .settings: return "RMM settings"
        case .profile: return "My profile"
        case .connect: return "Connect"
        }
    }
}

struct ViewerLaunch: Identifiable {
    let id = UUID()
    let url: URL
}

final class RMMState: ObservableObject {
    @Published var tenant: String
    @Published var route: RMMRoute = .dashboard
    @Published var showingMore = false
    @Published var showPortalTools = false
    @Published var viewer: ViewerLaunch?
    @Published var loading = false
    @Published var errorMessage: String?

    init() {
        tenant = UserDefaults.standard.string(forKey: "hi5central.rmm.tenant") ?? ""
    }

    var isConfigured: Bool { !tenant.isEmpty }
    var origin: URL? { URL(string: "https://\(tenant)-rmm.hi5central.com") }
    var host: String { "\(tenant)-rmm.hi5central.com" }

    func configure(_ value: String) -> Bool {
        let slug = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let allowed = "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
        guard slug.range(of: allowed, options: .regularExpression) != nil else {
            errorMessage = "Enter your company URL prefix, for example: newtest"
            return false
        }
        tenant = slug
        UserDefaults.standard.set(slug, forKey: "hi5central.rmm.tenant")
        route = .dashboard
        showingMore = false
        showPortalTools = false
        errorMessage = nil
        return true
    }

    func resetTenant() {
        tenant = ""
        UserDefaults.standard.removeObject(forKey: "hi5central.rmm.tenant")
        route = .dashboard
        showingMore = false
        showPortalTools = false
        viewer = nil
    }

    func navigate(to page: RMMRoute) {
        showPortalTools = false
        showingMore = false
        route = page
    }

    func routeForWebPath(_ path: String) -> RMMRoute? {
        let first = path.split(separator: "/").first.map(String.init) ?? ""
        return RMMRoute(rawValue: first.isEmpty ? "dashboard" : first)
    }

    func isTrustedHi5(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        return host == "hi5central.com" || host.hasSuffix(".hi5central.com")
    }

    func isViewer(_ url: URL) -> Bool {
        isTrustedHi5(url) && url.path.hasPrefix("/rmm-viewer/")
    }

    func showViewer(_ url: URL) {
        guard isViewer(url) else { return }
        viewer = ViewerLaunch(url: url)
    }
}
