import SwiftUI

private let operationBlue = Color(red: 0.18, green: 0.48, blue: 0.96)

private struct AutomationSelection: Identifiable {
    let data: [String: Any]
    let index: Int
    var id: Int { index }
}

struct NativeAutomation: View {
    @EnvironmentObject private var client: RMMClient
    @State private var automations: [[String: Any]] = []
    @State private var jobs: [[String: Any]] = []
    @State private var tab = 0
    @State private var failure: String?
    @State private var busy = false
    @State private var selected: AutomationSelection?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Automation").font(.title2.bold())
                Text("Published scripts and recent execution history")
                    .font(.subheadline).foregroundStyle(.secondary)
                Picker("Automation", selection: $tab) {
                    Text("Automations").tag(0)
                    Text("Jobs").tag(1)
                }
                .pickerStyle(.segmented)
                if busy { ProgressView().frame(maxWidth: .infinity) }
                if let failure { NativeIssue(message: failure) }
                if tab == 0 {
                    if automations.isEmpty && !busy {
                        emptyState("No automations", "No automations are available for this account.", "bolt")
                    }
                    ForEach(automations.indices, id: \.self) { index in
                        let row = automations[index]
                        Button {
                            selected = AutomationSelection(data: row, index: index)
                        } label: {
                            VStack(alignment: .leading, spacing: 11) {
                                HStack {
                                    Image(systemName: "bolt.circle").foregroundStyle(operationBlue)
                                    Text(nativeText(row, ["name"], fallback: "Automation"))
                                        .font(.headline).foregroundStyle(.primary)
                                    Spacer(minLength: 4)
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                                Text(nativeText(row, ["description"], fallback: "No description"))
                                    .font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(2)
                                HStack {
                                    Text(nativeText(row, ["platform"], fallback: "Any device"))
                                    Spacer()
                                    Text(nativeText(row, ["status"], fallback: "Draft").capitalized)
                                }
                                .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                            }
                            .padding(15)
                            .background(Color(uiColor: .secondarySystemBackground),
                                        in: RoundedRectangle(cornerRadius: 16))
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    if jobs.isEmpty && !busy { emptyState("No recent jobs", "Automation history will appear here.", "clock") }
                    ForEach(jobs.indices, id: \.self) { index in
                        let job = jobs[index]
                        NativePanel(title: nativeText(job, ["automation_name", "job_type"], fallback: "Agent job"),
                                    symbol: "checkmark.circle") {
                            Text(nativeText(job, ["device_name", "device_reference"], fallback: "Managed device"))
                                .font(.subheadline).foregroundStyle(.secondary)
                            HStack {
                                Text(nativeText(job, ["status"]).capitalized)
                                Spacer()
                                Text(nativeText(job, ["created_at"]))
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await refresh() }
        .task { await refresh() }
        .sheet(item: $selected) { selected in
            NativeAutomationDetail(data: selected.data)
                .environmentObject(client)
                .presentationDragIndicator(.visible)
        }
    }

    private func refresh() async {
        busy = true
        defer { busy = false }
        do {
            let a = try await client.nativeRead(.automations)
            automations = nativeRows(a["automations"])
            let j = try await client.nativeRead(.jobs)
            jobs = nativeRows(j["jobs"])
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

private struct NativeAutomationDetail: View {
    @EnvironmentObject private var client: RMMClient
    @Environment(\.dismiss) private var dismiss
    let data: [String: Any]

    @State private var chosenDevice = ""
    @State private var confirmRun = false
    @State private var busy = false
    @State private var resultMessage: String?
    private var targets: [ManagedDevice] { client.devices.filter(\.isOnline) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "bolt.circle.fill").font(.system(size: 42))
                        .foregroundStyle(operationBlue)
                    Text(nativeText(data, ["name"], fallback: "Automation")).font(.title2.bold())
                    Text(nativeText(data, ["description"], fallback: "No description provided"))
                        .font(.subheadline).foregroundStyle(.secondary)
                    NativePanel(title: "Automation details", symbol: "info.circle") {
                        HStack { Text("Platform"); Spacer(); Text(nativeText(data, ["platform"])) }
                        HStack { Text("Status"); Spacer(); Text(nativeText(data, ["status"]).capitalized) }
                        HStack { Text("Published version"); Spacer(); Text(nativeText(data, ["published_version_number"])) }
                    }
                    .font(.subheadline)
                    NativePanel(title: "Run on device", symbol: "desktopcomputer") {
                        Picker("Select device", selection: $chosenDevice) {
                            Text("Choose an online device").tag("")
                            ForEach(targets) { device in
                                Text(device.name).tag(device.agentId)
                            }
                        }
                        .pickerStyle(.menu)
                        Button {
                            confirmRun = true
                        } label: {
                            Label("Run automation", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(chosenDevice.isEmpty || busy || nativeString(data["status"]) != "published")
                        if busy { ProgressView() }
                        if let resultMessage {
                            Text(resultMessage).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(18)
            }
            .navigationTitle("Automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .confirmationDialog("Run this automation?", isPresented: $confirmRun, titleVisibility: .visible) {
                Button("Run on selected device") {
                    guard let device = targets.first(where: { $0.agentId == chosenDevice }),
                          let id = data["id"] as? String else { return }
                    Task {
                        busy = true
                        defer { busy = false }
                        do {
                            try await client.executeAutomation(id: id, device: device)
                            resultMessage = "Automation queued successfully."
                        } catch {
                            resultMessage = error.localizedDescription
                        }
                    }
                }
            } message: {
                Text("This executes the published script on the selected managed device.")
            }
        }
        .task { await client.refreshDevices() }
    }
}

struct NativeReports: View {
    @EnvironmentObject private var client: RMMClient
    @State private var activity: [[String: Any]] = []
    @State private var jobs: [[String: Any]] = []
    @State private var busy = false
    @State private var failure: String?

    private var failedJobs: Int {
        jobs.filter { ["failed", "error"].contains(nativeString($0["status"]).lowercased()) }.count
    }
    private var queuedJobs: Int {
        jobs.filter { ["queued", "claimed", "running"].contains(nativeString($0["status"]).lowercased()) }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Reports").font(.title2.bold())
                Text("Current device estate and operational activity")
                    .font(.subheadline).foregroundStyle(.secondary)
                if busy { ProgressView().frame(maxWidth: .infinity) }
                if let failure { NativeIssue(message: failure) }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 11) {
                    NativeMetric(title: "Managed devices", value: "\(client.installedCount)", symbol: "desktopcomputer")
                    NativeMetric(title: "Online devices", value: "\(client.onlineCount)", symbol: "network")
                    NativeMetric(title: "Active jobs", value: "\(queuedJobs)", symbol: "clock.arrow.circlepath")
                    NativeMetric(title: "Failed jobs", value: "\(failedJobs)", symbol: "exclamationmark.triangle")
                }
                NativePanel(title: "Recent events", symbol: "chart.bar.xaxis") {
                    if activity.isEmpty {
                        Text("No recent activity is available.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(activity.indices, id: \.self) { index in
                        let row = activity[index]
                        VStack(alignment: .leading, spacing: 5) {
                            Text(nativeText(row, ["summary", "event_type"], fallback: "RMM event"))
                                .font(.subheadline.weight(.semibold))
                            HStack {
                                Text(nativeText(row, ["outcome", "severity"], fallback: "Info").capitalized)
                                Spacer()
                                Text(nativeText(row, ["created_at", "occurred_at"], fallback: ""))
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                        }
                        if index < activity.count - 1 { Divider() }
                    }
                }
                Text("Metrics reflect current inventory and the most recent authorised jobs, not a historical billing or SLA report.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
        }
        .refreshable { await refresh() }
        .task { await refresh() }
    }

    private func refresh() async {
        busy = true
        defer { busy = false }
        await client.refreshDevices()
        do {
            let j = try await client.nativeRead(.jobs)
            jobs = nativeRows(j["jobs"])
            let a = try await client.nativeRead(.activity)
            activity = nativeRows(a["events"])
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

struct NativeConnect: View {
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState
    @State private var activeSessions: [[String: Any]] = []
    @State private var busy = false
    @State private var failure: String?
    @State private var deviceLaunching: String?
    @State private var selectedTermination: String?
    private var online: [ManagedDevice] { client.devices.filter(\.isOnline) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                Text("Remote Connect").font(.title2.bold())
                Text("Start secure remote desktop sessions from your iPhone")
                    .font(.subheadline).foregroundStyle(.secondary)
                if busy { ProgressView().frame(maxWidth: .infinity) }
                if let failure { NativeIssue(message: failure) }
                NativePanel(title: "Available devices", symbol: "display") {
                    if online.isEmpty {
                        Text("No online managed devices. Refresh your inventory to try again.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(online) { device in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(device.name).font(.subheadline.weight(.semibold))
                                Text(device.platform).font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 6)
                            Button {
                                Task { await open(device) }
                            } label: {
                                if deviceLaunching == device.agentId {
                                    ProgressView()
                                } else {
                                    Label("Connect", systemImage: "arrow.up.right")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(deviceLaunching != nil)
                        }
                        Divider()
                    }
                }
                NativePanel(title: "Active sessions", symbol: "bolt.horizontal.circle") {
                    if activeSessions.isEmpty {
                        Text("No active remote sessions.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(activeSessions.indices, id: \.self) { index in
                        let row = activeSessions[index]
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(nativeText(row, ["device_name"], fallback: "Remote device"))
                                    .font(.subheadline.bold())
                                Text(nativeText(row, ["technician", "mode"], fallback: "Technician"))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 3)
                            Button(role: .destructive) {
                                selectedTermination = nativeString(row["id"])
                            } label: {
                                Image(systemName: "xmark.circle")
                            }
                            .accessibilityLabel("End remote session")
                        }
                        Divider()
                    }
                }
                Text("Only start sessions on endpoints you are authorised to support.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(16)
        }
        .refreshable { await refresh() }
        .task { await refresh() }
        .confirmationDialog("End this remote session?", isPresented: Binding(
            get: { selectedTermination != nil },
            set: { if !$0 { selectedTermination = nil } }
        ), titleVisibility: .visible) {
            Button("End session", role: .destructive) {
                guard let id = selectedTermination else { return }
                selectedTermination = nil
                Task {
                    do {
                        try await client.terminateRemoteSession(id: id)
                        await refresh()
                    } catch {
                        failure = error.localizedDescription
                    }
                }
            }
        } message: {
            Text("The connected technician will be disconnected.")
        }
    }

    private func open(_ device: ManagedDevice) async {
        deviceLaunching = device.agentId
        defer { deviceLaunching = nil }
        do {
            let url = try await client.openRemote(for: device)
            await client.prepareViewerCookies()
            state.showViewer(url)
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }

    private func refresh() async {
        busy = true
        defer { busy = false }
        await client.refreshDevices()
        do {
            let response = try await client.nativeRead(.remoteSessions)
            activeSessions = nativeRows(response["sessions"])
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

struct NativeSettings: View {
    @EnvironmentObject private var client: RMMClient
    @AppStorage("hi5central.rmm.appearance") private var appearance = "system"
    @State private var policy: [String: Any] = [:]
    @State private var failure: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                Text("Settings").font(.title2.bold())
                NativePanel(title: "Appearance", symbol: "paintbrush") {
                    Picker("Appearance", selection: $appearance) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                    Text("System follows the iPhone's current appearance setting.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                NativePanel(title: "Notifications", symbol: "bell.badge") {
                    Text("Test the iOS alert system without an Apple Developer subscription.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button {
                        Task { await client.sendLocalNotificationTest() }
                    } label: {
                        Label("Send local test notification", systemImage: "paperplane")
                    }
                    .buttonStyle(.borderedProminent)
                    if let text = client.alertFeedback {
                        Text(text).font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Server-delivered push requires APNs signing and registration.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                NativePanel(title: "Agent tray policy", symbol: "slider.horizontal.3") {
                    Text(nativeText(policy, ["name"], fallback: "Default tray policy"))
                        .font(.subheadline.weight(.semibold))
                    let actions = nativeRows(policy["actions"])
                    Text("\(actions.count) configured tray actions")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(actions.indices, id: \.self) { index in
                        let row = actions[index]
                        Text(nativeText(row, ["label", "automation_name"], fallback: "Tray action"))
                            .font(.caption)
                    }
                }
                if let failure { NativeIssue(message: failure) }
                NativePanel(title: "App information", symbol: "info.circle") {
                    HStack {
                        Text("Version").foregroundStyle(.secondary)
                        Spacer()
                        Text("0.4.0")
                    }.font(.subheadline)
                    HStack {
                        Text("Company").foregroundStyle(.secondary)
                        Spacer()
                        Text(client.companyName)
                    }.font(.subheadline)
                    Text("Native iOS interface, original Hi5Central services and encrypted remote viewer.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(16)
        }
        .task {
            do {
                policy = try await client.nativeRead(.trayPolicy)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

struct NativeProfile: View {
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 15) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 60)).foregroundStyle(operationBlue)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(client.userName).font(.title2.bold())
                        Text(client.companyName).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                NativePanel(title: "Account", symbol: "person.crop.rectangle") {
                    HStack {
                        Text("Company").foregroundStyle(.secondary)
                        Spacer()
                        Text(state.tenant)
                    }.font(.subheadline)
                    HStack {
                        Text("Authentication").foregroundStyle(.secondary)
                        Spacer()
                        Label("Hi5Central session", systemImage: "checkmark.shield.fill")
                    }.font(.subheadline)
                    Text("Your session is validated against the Hi5Central RMM permissions and mandatory MFA.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                NativePanel(title: "Security", symbol: "lock.shield") {
                    Text("Passkeys and Face ID session unlock will be added after secure backend account registration and device association.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Button(role: .destructive) {
                    Task {
                        await client.signOut()
                        state.navigate(to: .dashboard)
                    }
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
        }
    }
}
