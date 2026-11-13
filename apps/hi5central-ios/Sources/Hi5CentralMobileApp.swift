import SwiftUI
import UserNotifications
import Combine

@main
struct Hi5CentralMobileApp: App {
    @StateObject private var auth = UnifiedMobileAuth()
    @StateObject private var itsm = ITSMClient()
    @StateObject private var rmm = RMMClient()
    @StateObject private var rmmState = RMMState()

    init() {
        UNUserNotificationCenter.current().delegate = UnifiedNotificationPresenter.shared
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

/// A single Hi5Central shell and a single tab bar. Product focus is an
/// optional display preference; subscription and permission checks still
/// come from the authenticated server session.
struct UnifiedMobileRoot: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState

    @AppStorage("hi5central.mobile.company") private var savedTenant = ""
    @AppStorage("hi5central.mobile.lockedTenants") private var lockedTenants = ""
    @AppStorage("hi5central.mobile.lockTimeouts") private var lockTimeouts = ""
    @AppStorage("hi5central.mobile.foregroundAlerts") private var foregroundAlerts = false
    @AppStorage("hi5central.mobile.workspaceFocus") private var workspaceFocus = "all"
    @AppStorage("hi5central.mobile.appearance") private var appearance = "system"
    @AppStorage("hi5central.rmm.nativeViewer") private var nativeViewer = true

    @State private var initializing = true
    @State private var loadingModules = false
    @State private var loadedTenant = ""
    @State private var activeTab = "home"
    @State private var searching = false
    @State private var showingNotifications = false
    @State private var showingCreateRecord = false
    @State private var showingFindDevice = false
    @State private var showingApprovals = false
    @State private var linkedDevice: ManagedDevice?
    @State private var deepLinkMessage: String?
    @State private var linkedRecord: ITSMRecord?
    @State private var pendingLink: URL?
    @State private var isLocked = false
    @State private var unlockBusy = false
    @State private var unlockIssue: String?
    @State private var lastBackgroundAt: Date?
    @State private var itsmReady = false
    @State private var rmmReady = false

    private var canITSM: Bool {
        auth.authenticated && auth.hasITSM && itsm.authenticated && itsmReady
    }
    private var canRMM: Bool {
        auth.authenticated && auth.hasRMM && rmm.authenticated && rmmReady
    }
    private var effectiveFocus: String {
        if canITSM && canRMM {
            return ["itsm", "rmm"].contains(workspaceFocus) ? workspaceFocus : "all"
        }
        return canITSM ? "itsm" : "rmm"
    }

    var body: some View {
        Group {
            if initializing {
                UnifiedLaunchView()
            } else if !auth.authenticated {
                UnifiedMobileLogin()
            } else if isLocked {
                UnifiedPrivacyLockScreen(
                    tenant: auth.tenant, busy: unlockBusy, issue: unlockIssue,
                    unlock: { Task { await unlockSession() } },
                    signOut: { Task { await auth.signOut() } }
                )
            } else if loadingModules {
                UnifiedLaunchView(message: "Preparing your workspaces…")
            } else if canITSM || canRMM {
                workspace
            } else {
                unavailableView
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
            UnifiedGlobalSearch()
                .environmentObject(auth)
                .environmentObject(itsm)
                .environmentObject(rmm)
                .environmentObject(rmmState)
        }
        .sheet(isPresented: $showingNotifications) {
            UnifiedActivityInbox()
                .environmentObject(auth)
                .environmentObject(itsm)
                .environmentObject(rmm)
                .environmentObject(rmmState)
        }
        .sheet(isPresented: $showingCreateRecord) {
            if canITSM {
                ITSMRecordComposer().environmentObject(itsm)
            }
        }
        .sheet(isPresented: $showingFindDevice) {
            if canRMM {
                NavigationStack {
                    UnifiedDeviceHub()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { showingFindDevice = false }
                            }
                        }
                }
                .environmentObject(rmm)
                .environmentObject(rmmState)
            }
        }
        .sheet(isPresented: $showingApprovals) {
            if canITSM {
                NavigationStack {
                    ITSMApprovalsView()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { showingApprovals = false }
                            }
                        }
                }
                .environmentObject(itsm)
            }
        }
        .sheet(item: $linkedRecord) { record in
            ITSMRecordDetail(record: record).environmentObject(itsm)
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
                        Text("Keep these securely. Recovery codes are not saved in the app.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
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
            if auth.authenticated {
                isLocked = UnifiedSecurityRules.isLocked(
                    tenant: auth.tenant, settings: lockedTenants)
                await loadModules()
            }
            initializing = false
        }
        .onChange(of: auth.authenticated) { signedIn in
            if signedIn {
                savedTenant = auth.tenant
                isLocked = UnifiedSecurityRules.isLocked(
                    tenant: auth.tenant, settings: lockedTenants)
                Task { await loadModules() }
            } else {
                isLocked = false
                pendingLink = nil
                linkedRecord = nil
                unlockIssue = nil
                lastBackgroundAt = nil
                itsm.clearLocalSession()
                rmm.clearLocalSession()
                loadedTenant = ""
                itsmReady = false
                rmmReady = false
                activeTab = "home"
                linkedDevice = nil
                showingNotifications = false
                showingCreateRecord = false
                showingFindDevice = false
                showingApprovals = false
                searching = false
                rmmState.viewer = nil
            }
        }
        .onChange(of: workspaceFocus) { _ in
            activeTab = "home"
        }
        .onChange(of: activeTab) { next in
            if canRMM {
                if next == "devices" { rmmState.navigate(to: .devices) }
                if next == "alerts" { rmmState.navigate(to: .alerts) }
            }
        }
        .onChange(of: rmmState.route) { route in
            if route == .devices && canRMM && effectiveFocus != "itsm" {
                activeTab = "devices"
            } else if route == .alerts && effectiveFocus == "rmm" {
                activeTab = "alerts"
            }
        }
        .onOpenURL { url in
            receiveLink(url)
        }
        .onReceive(NotificationCenter.default.publisher(for: UnifiedNotificationPresenter.routeNotification)) { event in
            if let url = event.object as? URL { receiveLink(url) }
        }
        .onChange(of: loadingModules) { loading in
            if !loading { openPendingLink() }
        }
        .onChange(of: scenePhase) { phase in
            guard auth.authenticated,
                  UnifiedSecurityRules.isLocked(tenant: auth.tenant, settings: lockedTenants)
            else { return }
            if phase == .background {
                lastBackgroundAt = Date()
                // Remote sessions must not remain unattended in the grace period.
                rmmState.viewer = nil
                linkedDevice = nil
                linkedRecord = nil
                showingNotifications = false
                showingCreateRecord = false
                showingFindDevice = false
                showingApprovals = false
                searching = false
                if UnifiedSecurityRules.timeout(tenant: auth.tenant, settings: lockTimeouts) == 0 {
                    isLocked = true
                }
            } else if phase == .active, let backgroundAt = lastBackgroundAt {
                lastBackgroundAt = nil
                let allowance = UnifiedSecurityRules.timeout(
                    tenant: auth.tenant, settings: lockTimeouts)
                if Date().timeIntervalSince(backgroundAt) >= Double(allowance) {
                    isLocked = true
                }
            }
        }
        .task(id: "\(auth.tenant)|\(auth.authenticated)|\(scenePhase == .active)|\(foregroundAlerts)") {
            await monitorForegroundAlerts()
        }
    }

    private var unavailableView: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.shield").font(.largeTitle)
            Text("Workspace unavailable").font(.headline)
            Text("Your company session is active, but no subscribed mobile module could be opened. Check staff permissions or retry.")
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

    private func loadModules() async {
        guard auth.authenticated, !loadingModules else { return }
        let tenant = auth.tenant
        if loadedTenant == tenant && (canITSM || canRMM) { return }
        loadingModules = true
        defer { loadingModules = false }

        if auth.hasITSM {
            await itsm.restore(tenant)
            guard auth.authenticated && auth.tenant == tenant else { return }
            itsmReady = itsm.authenticated
        } else {
            itsmReady = false
        }

        if auth.hasRMM {
            guard rmmState.configure(tenant) else { rmmReady = false; return }
            await rmm.restore(tenant)
            guard auth.authenticated && auth.tenant == tenant else { return }
            rmmReady = rmm.authenticated
            if rmmReady { await rmm.prepareViewerCookies() }
        } else {
            rmmReady = false
        }

        loadedTenant = tenant
        activeTab = "home"
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
                Menu {
                    if canITSM {
                        Button {
                            showingCreateRecord = true
                        } label: {
                            Label("New ticket", systemImage: "plus.app")
                        }
                        Button {
                            showingApprovals = true
                        } label: {
                            Label("Approvals", systemImage: "checkmark.shield")
                        }
                    }
                    if canRMM {
                        Button {
                            showingFindDevice = true
                        } label: {
                            Label("Find a device", systemImage: "desktopcomputer")
                        }
                    }
                    Button {
                        searching = true
                    } label: {
                        Label("Search all workspaces", systemImage: "magnifyingglass")
                    }
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 22))
                        .frame(width: 34, height: 36)
                }
                .accessibilityLabel("Quick actions")
                Button { searching = true } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 19))
                        .frame(width: 32, height: 36)
                }
                .accessibilityLabel("Search across Hi5Central")
                Button { showingNotifications = true } label: {
                    Image(systemName: "bell")
                        .font(.system(size: 18))
                        .frame(width: 34, height: 36)
                        .overlay(alignment: .topTrailing) {
                            if (canITSM && itsm.notifications.contains(where: {
                                ($0["read"] as? Bool) != true
                            })) || (canRMM && !rmm.offlineDevices.isEmpty) {
                                Circle()
                                    .fill(.red)
                                    .frame(width: 7, height: 7)
                                    .offset(x: -2, y: 3)
                            }
                        }
                }
                .accessibilityLabel("Notifications and alerts")
            }
            .padding(.horizontal, 14)
            .frame(height: 52)
            Divider()
            unifiedTabs
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .alert("Linked device", isPresented: Binding(
            get: { deepLinkMessage != nil },
            set: { if !$0 { deepLinkMessage = nil } })) {
            Button("OK") { deepLinkMessage = nil }
        } message: {
            Text(deepLinkMessage ?? "")
        }
    }

    /// Exactly one native tab bar at a time, regardless of the number
    /// of products. There is no permanent ITSM/RMM segmented switch.
    private var unifiedTabs: some View {
        TabView(selection: $activeTab) {
            NavigationStack {
                homeScreen
            }
            .tabItem { Label("Home", systemImage: "house") }
            .tag("home")

            if canITSM && effectiveFocus != "rmm" {
                NavigationStack {
                    UnifiedRecordHub()
                }
                .tabItem { Label("Records", systemImage: "tray.full") }
                .tag("records")
            }

            if canRMM && effectiveFocus != "itsm" {
                NavigationStack {
                    UnifiedDeviceHub()
                }
                .tabItem { Label("Devices", systemImage: "desktopcomputer") }
                .tag("devices")
            }

            if canITSM && effectiveFocus != "rmm" {
                NavigationStack {
                    ITSMTasksView()
                }
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag("tasks")
            }

            if effectiveFocus == "itsm" && canITSM {
                NavigationStack {
                    ITSMKnowledgeView()
                }
                .tabItem { Label("Knowledge", systemImage: "books.vertical") }
                .tag("knowledge")
            }

            if effectiveFocus == "rmm" && canRMM {
                NavigationStack {
                    NativeAlerts()
                }
                .tabItem { Label("Alerts", systemImage: "bell") }
                .tag("alerts")

                NavigationStack {
                    UnifiedRMMToolHub()
                }
                .tabItem { Label("Tools", systemImage: "wrench.and.screwdriver") }
                .tag("tools")
            }

            NavigationStack {
                UnifiedMoreView()
            }
            .tabItem { Label("More", systemImage: "ellipsis.circle") }
            .tag("more")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var homeScreen: some View {
        if effectiveFocus == "all" && canITSM && canRMM {
            UnifiedHomeDashboard(
                showITSM: true,
                showRMM: true,
                openRecords: { activeTab = "records" },
                openDevices: { activeTab = "devices" },
                openTasks: { activeTab = "tasks" },
                openAlerts: { showingNotifications = true },
                newRecord: { showingCreateRecord = true },
                findDevice: { showingFindDevice = true },
                openApprovals: { showingApprovals = true },
                openSearch: { searching = true }
            )
        } else if effectiveFocus == "itsm" && canITSM {
            ITSMDashboard()
        } else if canRMM {
            NativeOverview()
        }
    }

    private func unlockSession() async {
        guard !unlockBusy else { return }
        unlockBusy = true
        defer { unlockBusy = false }
        if await UnifiedDeviceAuthentication.confirm("Unlock your Hi5Central workspace.") {
            isLocked = false
            unlockIssue = nil
            openPendingLink()
        } else {
            unlockIssue = "Device authentication was cancelled or unavailable."
        }
    }

    private func receiveLink(_ url: URL) {
        guard url.scheme?.lowercased() == "hi5central" else { return }
        if !auth.authenticated || isLocked || loadingModules {
            pendingLink = url
        } else {
            openDeepLink(url)
        }
    }

    private func openPendingLink() {
        guard auth.authenticated, !isLocked, !loadingModules,
              canITSM || canRMM, let url = pendingLink else { return }
        pendingLink = nil
        openDeepLink(url)
    }

    private func openDeepLink(_ url: URL) {
        guard url.scheme?.lowercased() == "hi5central" else { return }
        let requestedTenant = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "tenant" })?.value
        if let requestedTenant, requestedTenant != auth.tenant {
            deepLinkMessage = "This link belongs to a different company. Switch companies and sign in again."
            return
        }
        guard let target = url.host?.lowercased() else { return }
        if target == "device" {
            openLinkedDevice(url)
        } else if target == "record" {
            guard canITSM,
                  let reference = url.pathComponents.dropFirst().first,
                  reference.range(of: #"^[A-Za-z0-9-]{1,80}$"#,
                                  options: .regularExpression) != nil else {
                deepLinkMessage = "This record link cannot be opened for the signed-in account."
                return
            }
            Task {
                await itsm.refreshRecords()
                guard canITSM else { return }
                if let match = itsm.records.first(where: {
                    $0.id.caseInsensitiveCompare(reference) == .orderedSame
                }) {
                    linkedRecord = match
                } else {
                    deepLinkMessage = "The record is not in your authorised ITSM workspace."
                }
            }
        }
    }

    /// Visible-only polling. This does NOT provide APNs or notifications when the app is closed.
    private func monitorForegroundAlerts() async {
        guard foregroundAlerts, auth.authenticated, scenePhase == .active else { return }
        for _ in 0..<25 {
            if Task.isCancelled || !auth.authenticated { return }
            if !loadingModules && (canITSM || canRMM) { break }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        guard canITSM || canRMM else { return }
        var knownNotices = Set(itsm.notifications.compactMap {
            itsmString($0["id"]).isEmpty ? nil : itsmString($0["id"])
        })
        var offline = Set(rmm.offlineDevices.map(\.id))
        let initialTenant = auth.tenant
        while !Task.isCancelled && auth.authenticated &&
              auth.tenant == initialTenant && scenePhase == .active {
            do { try await Task.sleep(nanoseconds: 60_000_000_000) }
            catch { return }
            guard !Task.isCancelled, foregroundAlerts, auth.authenticated,
                  auth.tenant == initialTenant else { return }
            if canITSM {
                await itsm.refreshNotifications()
                for notice in itsm.notifications {
                    let id = itsmString(notice["id"])
                    guard !id.isEmpty else { continue }
                    let isNew = knownNotices.insert(id).inserted
                    guard isNew, (notice["read"] as? Bool) != true else { continue }
                    let reference = ["recordReference", "recordId", "reference"]
                        .map { itsmString(notice[$0]) }.first { !$0.isEmpty } ?? ""
                    let valid = reference.range(of: #"^[A-Za-z0-9-]{1,80}$"#,
                                                options: .regularExpression) != nil
                    let link = valid ? URL(string: "hi5central://record/\(reference)?tenant=\(initialTenant)") : nil
                    try? await UnifiedLocalNotification.send(
                        title: "Hi5Central Service Desk",
                        message: "You have new activity in your service desk.",
                        url: link)
                }
            }
            if canRMM {
                await rmm.refreshDevices()
                let nowOffline = Set(rmm.offlineDevices.map(\.id))
                for device in rmm.offlineDevices where !offline.contains(device.id) {
                    let id = UUID(uuidString: device.agentId) != nil ? device.agentId : device.id
                    let link = UUID(uuidString: id) == nil ? nil :
                        URL(string: "hi5central://device/\(id)?tenant=\(initialTenant)")
                    try? await UnifiedLocalNotification.send(
                        title: "Hi5Central Remote Monitoring",
                        message: "A managed device has gone offline.",
                        url: link)
                }
                offline = nowOffline
            }
        }
    }

    private func openLinkedDevice(_ url: URL) {
        guard url.scheme?.lowercased() == "hi5central",
              url.host?.lowercased() == "device",
              canRMM, let identifier = url.pathComponents.dropFirst().first,
              UUID(uuidString: identifier) != nil else {
            return
        }
        Task {
            if rmm.devices.isEmpty { await rmm.refreshDevices() }
            guard canRMM else { return }
            if let match = rmm.devices.first(where: {
                $0.agentId == identifier || $0.id == identifier
            }) {
                linkedDevice = match
            } else {
                deepLinkMessage = "This device isn't in your authorised RMM inventory."
            }
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
