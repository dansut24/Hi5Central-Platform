import SwiftUI
import UserNotifications

@main
struct Hi5CentralMobileApp: App {
    @StateObject private var auth = UnifiedMobileAuth()
    @StateObject private var itsm = ITSMClient()
    @StateObject private var rmm = RMMClient()
    @StateObject private var rmmState = RMMState()

    init() {
        UNUserNotificationCenter.current().delegate = NativeNotificationPresenter.shared
    }

    var body: some Scene {
        WindowGroup {
            UnifiedMobileRoot()
                .environmentObject(auth)
                .environmentObject(itsm)
                .environmentObject(rmm)
                .environmentObject(rmmState)
                .tint(Color(red: 0.16, green: 0.47, blue: 0.94))
        }
    }
}

struct UnifiedMobileRoot: View {
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState
    @AppStorage("hi5central.mobile.company") private var savedTenant = ""
    @AppStorage("hi5central.mobile.preferredModule") private var selectedModule = "itsm"
    @AppStorage("hi5central.mobile.appearance") private var appearance = "system"
    @AppStorage("hi5central.rmm.nativeViewer") private var nativeViewer = true
    @State private var initializing = true
    @State private var loadingModules = false
    @State private var loadedSession = ""
    @State private var searching = false
    @State private var rmmTab = 0
    @State private var linkedDevice: ManagedDevice?
    @State private var deepLinkMessage: String?
    @State private var itmsReady = false
    @State private var rmmReady = false

    private var canITSM: Bool { auth.hasITSM && itsm.authenticated && itmsReady }
    private var canRMM: Bool { auth.hasRMM && rmm.authenticated && rmmReady }
    private var displayingRMM: Bool {
        (selectedModule == "rmm" && canRMM) || (!canITSM && canRMM)
    }

    var body: some View {
        Group {
            if initializing {
                UnifiedLaunchView()
            } else if !auth.authenticated {
                UnifiedMobileLogin()
            } else if loadingModules {
                UnifiedLaunchView(message: "Preparing your workspaces…")
            } else if canITSM || canRMM {
                workspace
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "lock.shield").font(.largeTitle)
                    Text("Workspace unavailable").font(.headline)
                    Text("Your account is signed in, but no subscribed mobile module could be opened. Check tenant permissions or try refreshing.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await loadModules() } }
                        .buttonStyle(.borderedProminent)
                    Button("Sign out", role: .destructive) {
                        Task { await auth.signOut() }
                    }
                }
                .padding(28)
            }
        }
        .preferredColorScheme(appearance == "light" ? .light
                              : appearance == "dark" ? .dark : nil)
        .fullScreenCover(item: $rmmState.viewer) { launch in
            if nativeViewer {
                NativeRemoteViewerScreen(target: launch)
                    .environmentObject(rmm)
                    .environmentObject(rmmState)
            } else {
                RemoteViewerScreen(target: launch)
            }
        }
        .sheet(isPresented: $searching) {
            if displayingRMM {
                NativeGlobalSearch()
                    .environmentObject(rmm)
                    .environmentObject(rmmState)
            } else {
                ITSMGlobalSearch().environmentObject(itsm)
            }
        }
        .sheet(item: $linkedDevice) { device in
            NativeDeviceDetail(device: device)
                .environmentObject(rmm)
                .environmentObject(rmmState)
        }
        .sheet(isPresented: Binding(
            get: { !auth.recoveryCodes.isEmpty },
            set: { if !$0 { auth.clearRecoveryCodes() } })) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Label("Save recovery codes", systemImage: "lock.shield")
                            .font(.headline)
                        Text("Store these securely. They are not saved inside Hi5Central.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(auth.recoveryCodes, id: \.self) { code in
                            Text(code)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Button("I've saved these codes") { auth.clearRecoveryCodes() }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(18)
                }
                .navigationTitle("MFA recovery")
            }
        }
        .task {
            await auth.restore(savedTenant)
            if auth.authenticated { await loadModules() }
            initializing = false
        }
        .onChange(of: auth.authenticated) { loggedIn in
            if loggedIn {
                savedTenant = auth.tenant
                Task { await loadModules() }
            } else {
                loadedSession = ""
                itmsReady = false
                rmmReady = false
                linkedDevice = nil
                rmmState.viewer = nil
            }
        }
        .onChange(of: rmmState.route) { route in
            switch route {
            case .dashboard: rmmTab = 0
            case .devices: rmmTab = 1
            case .alerts: rmmTab = 2
            default: rmmTab = 3
            }
        }
        .onOpenURL { url in
            guard url.scheme == "hi5central",
                  url.host == "device",
                  canRMM, let key = url.pathComponents.dropFirst().first else { return }
            selectedModule = "rmm"
            rmmState.navigate(to: .devices)
            if let match = rmm.devices.first(where: { $0.agentId == key || $0.id == key }) {
                linkedDevice = match
            } else {
                deepLinkMessage = "This linked device isn't in your accessible RMM inventory."
            }
        }
    }

    private func loadModules() async {
        guard auth.authenticated else { return }
        if loadedSession == auth.tenant && (canITSM || canRMM) { return }
        loadingModules = true
        defer { loadingModules = false }
        if auth.hasITSM {
            await itsm.restore(auth.tenant)
            itmsReady = itsm.authenticated
        } else { itmsReady = false }
        if auth.hasRMM {
            _ = rmmState.configure(auth.tenant)
            await rmm.restore(auth.tenant)
            rmmReady = rmm.authenticated
            if rmmReady { await rmm.prepareViewerCookies() }
        } else { rmmReady = false }
        loadedSession = auth.tenant
        if !canITSM && canRMM { selectedModule = "rmm" }
        else if canITSM && !canRMM { selectedModule = "itsm" }
    }

    private var workspace: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ITSMBrand(size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hi5Central")
                        .font(.system(size: 16, weight: .bold))
                    Text(auth.companyName.isEmpty ? auth.tenant : auth.companyName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Button { searching = true } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 19))
                        .frame(width: 34, height: 34)
                }
                .accessibilityLabel("Search current workspace")
                Button {
                    Task {
                        if displayingRMM { await rmm.refreshDevices() }
                        else { await itsm.refreshAll() }
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: 34, height: 34)
                }
                .accessibilityLabel("Refresh current workspace")
            }
            .padding(.horizontal, 14)
            .frame(height: 52)

            if canITSM && canRMM {
                Picker("Product", selection: $selectedModule) {
                    Text("Service Desk").tag("itsm")
                    Text("Remote Monitoring").tag("rmm")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.bottom, 8)
                .accessibilityLabel("Switch between ITSM and RMM")
            }
            Divider()
            if displayingRMM { rmmWorkspace }
            else { itsmWorkspace }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .alert("Linked device", isPresented: Binding(
            get: { deepLinkMessage != nil }, set: { if !$0 { deepLinkMessage = nil } })) {
            Button("OK") { deepLinkMessage = nil }
        } message: {
            Text(deepLinkMessage ?? "")
        }
    }

    private var itsmWorkspace: some View {
        TabView {
            NavigationStack { ITSMDashboard() }
                .tabItem { Label("Home", systemImage: "house") }
            NavigationStack { ITSMRecordsView() }
                .tabItem { Label("Records", systemImage: "tray.full") }
            NavigationStack { ITSMTasksView() }
                .tabItem { Label("Tasks", systemImage: "checklist") }
            NavigationStack { ITSMKnowledgeView() }
                .tabItem { Label("Knowledge", systemImage: "books.vertical") }
            NavigationStack { UnifiedITSMMore() }
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var rmmWorkspace: some View {
        TabView(selection: $rmmTab) {
            NavigationStack { NativeOverview() }
                .tabItem { Label("Home", systemImage: "house") }.tag(0)
            NavigationStack { NativeDeviceList() }
                .tabItem { Label("Devices", systemImage: "desktopcomputer") }.tag(1)
            NavigationStack { NativeAlerts() }
                .tabItem { Label("Alerts", systemImage: "bell") }.tag(2)
            NavigationStack { UnifiedRMMMore() }
                .tabItem { Label("Tools", systemImage: "square.grid.2x2") }.tag(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: rmmTab) { index in
            switch index {
            case 0: rmmState.navigate(to: .dashboard)
            case 1: rmmState.navigate(to: .devices)
            case 2: rmmState.navigate(to: .alerts)
            default: rmmState.showingMore = true
            }
        }
    }
}

private struct UnifiedITSMMore: View {
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @AppStorage("hi5central.mobile.appearance") private var appearance = "system"
    var body: some View {
        List {
            Section("Service Desk") {
                NavigationLink { ITSMApprovalsView() } label: {
                    Label("Approvals", systemImage: "checkmark.shield")
                }
                NavigationLink { ITSMDirectoryView() } label: {
                    Label("People", systemImage: "person.2")
                }
                NavigationLink { ITSMCMDBView() } label: {
                    Label("CMDB", systemImage: "server.rack")
                }
                NavigationLink { ITSMProjectsView() } label: {
                    Label("Projects", systemImage: "square.stack.3d.up")
                }
                NavigationLink { ITSMCalendarView() } label: {
                    Label("Calendar", systemImage: "calendar")
                }
                NavigationLink { ITSMNotificationsView() } label: {
                    Label("Notifications", systemImage: "bell.badge")
                }
            }
            sharedSettings
        }
        .navigationTitle("More")
    }

    private var sharedSettings: some View {
        Group {
            Section("Appearance") {
                Picker("Theme", selection: $appearance) {
                    Text("Automatic").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            }
            Section {
                Button("Sign out", role: .destructive) {
                    Task { await auth.signOut() }
                }
            }
        }
    }
}

private struct UnifiedRMMMore: View {
    @EnvironmentObject private var state: RMMState
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @AppStorage("hi5central.mobile.appearance") private var appearance = "system"

    var body: some View {
        Group {
            if state.showingMore ||
                [.dashboard, .devices, .alerts].contains(state.route) {
                List {
                    Section("Remote Monitoring") {
                        ForEach([
                            ("Connect", "antenna.radiowaves.left.and.right", RMMRoute.connect),
                            ("Patching", "checkmark.shield", RMMRoute.patching),
                            ("Software", "shippingbox", RMMRoute.software),
                            ("Automation", "bolt", RMMRoute.automation),
                            ("Reports", "chart.bar", RMMRoute.reports),
                            ("Settings", "gearshape", RMMRoute.settings)
                        ], id: \.0) { name, symbol, route in
                            Button {
                                state.navigate(to: route)
                            } label: {
                                Label(name, systemImage: symbol)
                            }
                        }
                    }
                    Section("Appearance") {
                        Picker("Theme", selection: $appearance) {
                            Text("Automatic").tag("system")
                            Text("Light").tag("light")
                            Text("Dark").tag("dark")
                        }
                    }
                    Section {
                        Button("Sign out", role: .destructive) {
                            Task { await auth.signOut() }
                        }
                    }
                }
                .navigationTitle("RMM tools")
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Button {
                            state.showingMore = true
                        } label: {
                            Label("All tools", systemImage: "chevron.left")
                        }
                        Spacer()
                    }
                    .padding(13)
                    Divider()
                    toolScreen
                }
            }
        }
    }

    @ViewBuilder
    private var toolScreen: some View {
        switch state.route {
        case .patching: NativePatching()
        case .software: NativeSoftware()
        case .automation: NativeAutomation()
        case .reports: NativeReports()
        case .settings: NativeSettings()
        case .connect: NativeConnect()
        case .profile: NativeProfile()
        default: NativeMore()
        }
    }
}

private struct UnifiedLaunchView: View {
    var message = "Connecting to Hi5Central…"

    var body: some View {
        ZStack {
            Color(red: 0.027, green: 0.045, blue: 0.083).ignoresSafeArea()
            VStack(spacing: 16) {
                Spacer()
                ITSMBrand(size: 90)
                Text("Hi5Central")
                    .font(.largeTitle.bold()).foregroundStyle(.white)
                Text("IT Service Management + Remote Monitoring")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.72))
                Spacer()
                ProgressView().tint(.white)
                Text(message).font(.caption).foregroundStyle(.white.opacity(0.7))
            }
            .padding(26)
        }
    }
}
