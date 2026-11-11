import SwiftUI

private let hi5Blue = Color(red: 0.18, green: 0.48, blue: 0.96)

struct RootView: View {
    @EnvironmentObject private var state: RMMState
    @EnvironmentObject private var client: RMMClient
    @State private var splash = true
    @AppStorage("hi5central.rmm.nativeViewer") private var nativeViewerEnabled = true
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
            if nativeViewerEnabled {
                NativeRemoteViewerScreen(target: target)
                    .environmentObject(client)
            } else {
                RemoteViewerScreen(target: target)
            }
        }
        .onOpenURL { url in
            // A Dynamic Island tap foregrounds this app. If the session is
            // still open, the existing full-screen viewer is retained.
            guard url.scheme == "hi5central-rmm", url.host == "remote",
                  let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "session" })?.value,
                  let active = state.viewer,
                  NativeViewerParameters(url: active.url)?.sessionId == id else { return }
            state.viewer = active
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
                tab("More", icon: "square.grid.2x2", isActive: state.showingMore || ![.dashboard, .devices, .alerts].contains(state.route)) {
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

