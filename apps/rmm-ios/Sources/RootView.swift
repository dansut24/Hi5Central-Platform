import SwiftUI
import WebKit
import UIKit

private let hi5Blue = Color(red: 0.18, green: 0.48, blue: 0.96)

struct RootView: View {
    @EnvironmentObject private var state: RMMState
    @State private var tenantEntry = ""
    @State private var webReloadID = UUID()

    var body: some View {
        Group {
            if state.isConfigured {
                applicationShell
            } else {
                welcome
            }
        }
        .preferredColorScheme(nil)
        .fullScreenCover(item: $state.viewer) { target in
            RemoteViewerScreen(target: target)
        }
    }

    private var welcome: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "desktopcomputer")
                .font(.system(size: 38, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 84, height: 84)
                .background(hi5Blue.gradient, in: RoundedRectangle(cornerRadius: 22))
            VStack(spacing: 6) {
                Text("Hi5Central RMM").font(.largeTitle.bold())
                Text("Remote monitoring and support")
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("Your company").font(.headline)
                HStack(spacing: 0) {
                    TextField("Company prefix", text: $tenantEntry)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .submitLabel(.go)
                        .onSubmit { _ = state.configure(tenantEntry) }
                    Text("-rmm.hi5central.com")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
                Button {
                    _ = state.configure(tenantEntry)
                } label: {
                    Label("Continue", systemImage: "arrow.right")
                        .frame(maxWidth: .infinity)
                        .padding(8)
                }
                .buttonStyle(.borderedProminent)
                if let error = state.errorMessage {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                Text("Your existing Hi5Central login and MFA will be used.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(22)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
            Spacer()
            Text("Native iOS preview · version 0.2.0")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(24)
    }

    private var applicationShell: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(hi5Blue.gradient, in: RoundedRectangle(cornerRadius: 11))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hi5Central RMM").font(.subheadline.bold())
                    Text(state.showingMore ? "More" : state.route.title)
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if !state.showingMore {
                    Button {
                        state.showPortalTools.toggle()
                    } label: {
                        Image(systemName: state.showPortalTools ? "xmark" : "magnifyingglass")
                            .font(.system(size: 17, weight: .medium))
                            .frame(width: 30, height: 36)
                    }
                    .accessibilityLabel(state.showPortalTools ? "Hide website tools" : "Search and account tools")
                    Button {
                        webReloadID = UUID()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 17, weight: .medium))
                            .frame(width: 30, height: 36)
                    }
                    .accessibilityLabel("Refresh")
                }
            }
            .padding(.horizontal, 18)
            .frame(height: 50)
            Divider()
            ZStack {
                PortalWebView(state: state)
                    .id(webReloadID)
                    .opacity(state.showingMore ? 0 : 1)
                    .allowsHitTesting(!state.showingMore)
                if state.showingMore {
                    morePage
                }
                if state.loading && !state.showingMore {
                    ProgressView().padding(12)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
            }
            Divider()
            HStack {
                tab("Home", symbol: "house", selected: !state.showingMore && state.route == .dashboard) {
                    state.navigate(to: .dashboard)
                }
                tab("Devices", symbol: "desktopcomputer", selected: !state.showingMore && state.route == .devices) {
                    state.navigate(to: .devices)
                }
                tab("Alerts", symbol: "bell", selected: !state.showingMore && state.route == .alerts) {
                    state.navigate(to: .alerts)
                }
                tab("More", symbol: "square.grid.2x2", selected: state.showingMore || ![.dashboard, .devices, .alerts].contains(state.route)) {
                    state.showingMore = true
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 4)
            .background(.regularMaterial)
        }
        .background(Color(uiColor: .systemBackground))
    }

    private func tab(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 20, weight: selected ? .semibold : .regular))
                Text(title).font(.system(size: 10, weight: selected ? .bold : .medium))
            }
            .foregroundStyle(selected ? hi5Blue : Color.secondary)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var morePage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Manage your environment").font(.title2.bold())
                Text("Quick access to other RMM workspaces")
                    .font(.subheadline).foregroundStyle(.secondary)
                ForEach([RMMRoute.connect, .patching, .software, .automation, .reports, .settings, .profile]) { route in
                    Button {
                        state.navigate(to: route)
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: icon(for: route))
                                .foregroundStyle(hi5Blue)
                                .frame(width: 30)
                            Text(route.title).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(17)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 15))
                    }
                    .buttonStyle(.plain)
                }
                Divider()
                Text("Connected company: \(state.tenant)")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(role: .destructive) {
                    state.resetTenant()
                    webReloadID = UUID()
                } label: {
                    Label("Switch company", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .padding(.top, 4)
            }
            .padding(18)
        }
    }

    private func icon(for route: RMMRoute) -> String {
        switch route {
        case .patching: return "checkmark.shield"
        case .software: return "square.stack.3d.up"
        case .automation: return "bolt"
        case .reports: return "chart.bar"
        case .settings: return "gearshape"
        case .profile: return "person.crop.circle"
        case .connect: return "antenna.radiowaves.left.and.right"
        default: return "desktopcomputer"
        }
    }
}

struct PortalWebView: UIViewRepresentable {
    @ObservedObject var state: RMMState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "rmmRoute")
        config.userContentController.addUserScript(
            WKUserScript(source: NativeWebScripts.portal, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.openRoute(state.route, tenant: state.tenant, on: webView)
        return webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.state = state
        if context.coordinator.lastToolsVisibility != state.showPortalTools {
            context.coordinator.lastToolsVisibility = state.showPortalTools
            let visible = state.showPortalTools ? "true" : "false"
            view.evaluateJavaScript("document.documentElement.classList.toggle('hi5-native-tools', " + visible + ");", completionHandler: nil)
        }
        if context.coordinator.lastRoute != state.route || context.coordinator.lastTenant != state.tenant {
            context.coordinator.openRoute(state.route, tenant: state.tenant, on: view)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var state: RMMState
        var lastRoute: RMMRoute?
        var lastTenant: String?
        var lastToolsVisibility: Bool?

        init(state: RMMState) { self.state = state }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "rmmRoute", let path = message.body as? String,
                  let url = message.webView?.url, state.isTrustedHi5(url),
                  let destination = state.routeForWebPath(path) else { return }
            DispatchQueue.main.async {
                self.lastRoute = destination
                if self.state.route != destination {
                    self.state.route = destination
                }
            }
        }

        func openRoute(_ route: RMMRoute, tenant: String, on view: WKWebView) {
            lastRoute = route
            lastTenant = tenant
            guard let url = URL(string: "https://\(tenant)-rmm.hi5central.com\(route.path)") else { return }
            state.loading = true
            view.load(URLRequest(url: url))
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            state.loading = false
            state.errorMessage = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            state.loading = false
            state.errorMessage = error.localizedDescription
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "about" { decisionHandler(.allow); return }
            guard state.isTrustedHi5(url) else {
                if url.scheme == "https" { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame == nil {
                if state.isViewer(url) {
                    DispatchQueue.main.async { self.state.showViewer(url) }
                } else {
                    UIApplication.shared.open(url)
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // Browser viewer launches use window.open(..., '_blank', 'noopener').
            // Keep the WebRTC session inside the app, never hand its launch token to Safari.
            if let url = navigationAction.request.url, state.isViewer(url) {
                DispatchQueue.main.async { self.state.showViewer(url) }
            }
            return nil
        }
    }
}
