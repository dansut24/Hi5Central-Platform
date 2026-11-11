import SwiftUI
import WebKit
import UIKit

private let hi5Blue = Color(red: 0.18, green: 0.48, blue: 0.96)

struct RootView: View {
    @EnvironmentObject private var state: RMMState
    @EnvironmentObject private var client: RMMClient
    @State private var splash = true
    @State private var reloadID = UUID()
    @AppStorage("hi5central.rmm.appearance") private var appearance = "system"

    var body: some View {
        Group {
            if splash {
                NativeSplash()
            } else if client.authenticated {
                applicationShell
            } else {
                NativeLogin()
            }
        }
        .preferredColorScheme(appearance == "light" ? .light : (appearance == "dark" ? .dark : nil))
        .fullScreenCover(item: $state.viewer) { target in
            RemoteViewerScreen(target: target)
        }
        .sheet(isPresented: Binding(get: { !client.recoveryCodes.isEmpty },
                                    set: { if !$0 { client.finishRecoveryCodes() } })) {
            NativeRecoveryCodes()
                .environmentObject(client)
                .presentationDetents([.medium, .large])
        }
        .task {
            await client.restore(state.tenant)
            try? await Task.sleep(nanoseconds: 650_000_000)
            splash = false
        }
    }

    private var applicationShell: some View {
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                Hi5Mark(size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hi5Central RMM").font(.system(size: 15, weight: .bold))
                    Text(state.showingMore ? "Tools" : state.route.title)
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if !state.showingMore {
                    Button {
                        Task { await client.refreshDevices() }
                    } label: {
                        Image(systemName: "arrow.clockwise").frame(width: 30, height: 36)
                    }
                    .accessibilityLabel("Refresh device inventory")
                }
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { state.showingMore = true }
                } label: {
                    Image(systemName: "square.grid.2x2").frame(width: 30, height: 36)
                }
                .accessibilityLabel("Tools")
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 16)
            .frame(height: 52)
            Divider()
            ZStack {
                if state.showingMore {
                    NativeMore()
                } else {
                    switch state.route {
                    case .dashboard:
                        NativeOverview()
                    case .devices:
                        NativeDeviceList()
                    case .alerts:
                        NativeAlerts()
                    case .patching:
                        NativePatching()
                    case .software:
                        NativeSoftware()
                    case .automation:
                        NativeAutomation()
                    case .reports:
                        NativeReports()
                    case .settings:
                        NativeSettings()
                    case .profile:
                        NativeProfile()
                    case .connect:
                        NativeConnect()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack(spacing: 0) {
                tab("Home", icon: "house", isActive: !state.showingMore && state.route == .dashboard) {
                    state.navigate(to: .dashboard)
                }
                tab("Devices", icon: "desktopcomputer", isActive: !state.showingMore && state.route == .devices) {
                    state.navigate(to: .devices)
                }
                tab("Alerts", icon: "bell", isActive: !state.showingMore && state.route == .alerts) {
                    state.navigate(to: .alerts)
                }
                tab("More", icon: "square.grid.2x2", isActive: state.showingMore || !isNativeRoute) {
                    state.showingMore = true
                }
            }
            .padding(.top, 7)
            .padding(.bottom, 3)
            .background(Color(uiColor: .secondarySystemBackground))
        }
        .background(Color(uiColor: .systemBackground))
        .task { await client.prepareViewerCookies() }
    }

    private var isNativeRoute: Bool { true }

    private func tab(_ text: String, icon: String, isActive: Bool,
                     action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: isActive ? .semibold : .regular))
                Text(text)
                    .font(.system(size: 10, weight: isActive ? .bold : .medium))
            }
            .foregroundStyle(isActive ? hi5Blue : Color.secondary)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
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
