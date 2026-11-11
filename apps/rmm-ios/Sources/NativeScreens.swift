import SwiftUI

private let accent = Color(red: 0.18, green: 0.48, blue: 0.96)

struct Hi5Mark: View {
    var size: CGFloat = 48
    var body: some View {
        Image(systemName: "desktopcomputer")
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                LinearGradient(colors: [accent, Color(red: 0.10, green: 0.66, blue: 0.88)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: size * 0.26)
            )
    }
}

struct NativeSplash: View {
    var body: some View {
        ZStack {
            Color(red: 0.027, green: 0.045, blue: 0.083).ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                Hi5Mark(size: 90)
                VStack(spacing: 5) {
                    Text("Hi5Central").font(.system(size: 32, weight: .bold))
                    Text("REMOTE MONITORING & MANAGEMENT")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .tracking(2).foregroundStyle(.white.opacity(0.6))
                }
                Spacer()
                ProgressView().tint(.white)
                Text("Secure remote support").font(.caption).foregroundStyle(.white.opacity(0.6))
                    .padding(.bottom, 24)
            }
            .foregroundStyle(.white)
            .padding(24)
        }
    }
}

struct NativeLogin: View {
    @EnvironmentObject private var state: RMMState
    @EnvironmentObject private var client: RMMClient
    @State private var company = ""
    @State private var email = ""
    @State private var password = ""
    @State private var mfaCode = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                HStack {
                    Hi5Mark(size: 66)
                    Spacer()
                    Text("RMM").font(.caption.bold()).tracking(2)
                        .foregroundStyle(accent)
                        .padding(9)
                        .background(accent.opacity(0.10), in: Capsule())
                }
                .padding(.top, 28)

                VStack(alignment: .leading, spacing: 8) {
                    Text(client.needsMFA ? "Verify your identity" : "Welcome back")
                        .font(.largeTitle.bold())
                    Text(client.needsMFA
                         ? "Use your authenticator app or a recovery code to continue."
                         : "Sign in to securely manage your devices.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 17) {
                    if client.needsMFA {
                        if let secret = client.setupSecret {
                            VStack(alignment: .leading, spacing: 9) {
                                Label("Set up your authenticator", systemImage: "lock.shield")
                                    .font(.headline)
                                Text("Add this secret to your authenticator app before entering a code.")
                                    .font(.footnote).foregroundStyle(.secondary)
                                Text(secret)
                                    .font(.system(.subheadline, design: .monospaced))
                                    .textSelection(.enabled)
                                    .padding(12)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 11))
                                if let uri = client.setupURI, let url = URL(string: uri) {
                                    ShareLink("Share authenticator setup", item: url)
                                        .font(.footnote)
                                }
                            }
                        }
                        fieldTitle("Verification code")
                        TextField("6-digit code or recovery code", text: $mfaCode)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.asciiCapable)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .modifier(InputSurface())
                        Button {
                            Task {
                                await client.verifyMFA(mfaCode.trimmingCharacters(in: .whitespacesAndNewlines))
                                if client.authenticated { _ = state.configure(company) }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                if client.busy { ProgressView().tint(.white) }
                                Text("Verify and sign in")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(client.busy || mfaCode.isEmpty)

                        Button("Back to sign in") {
                            client.cancelMFA()
                            password = ""
                            mfaCode = ""
                        }
                        .font(.subheadline)
                    } else {
                        fieldTitle("Company")
                        HStack(spacing: 3) {
                            TextField("company", text: $company)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.asciiCapable)
                            Text("-rmm.hi5central.com")
                                .font(.caption2).foregroundStyle(.secondary)
                                .fixedSize()
                        }
                        .modifier(InputSurface())

                        fieldTitle("Work email")
                        TextField("you@company.com", text: $email)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.username)
                            .modifier(InputSurface())

                        fieldTitle("Password")
                        SecureField("Enter your password", text: $password)
                            .textContentType(.password)
                            .modifier(InputSurface())

                        Button {
                            Task {
                                await client.signIn(tenant: company, email: email, password: password)
                                password = ""
                                if client.authenticated { _ = state.configure(company) }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                if client.busy { ProgressView().tint(.white) }
                                Text("Sign in")
                                if !client.busy { Image(systemName: "arrow.right") }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(client.busy || company.isEmpty || email.isEmpty || password.isEmpty)
                    }

                    if let message = client.errorMessage {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))

                HStack(spacing: 9) {
                    Image(systemName: "lock.shield")
                    Text("Your password is never stored on this device. MFA remains required by Hi5Central.")
                }
                .font(.footnote).foregroundStyle(.secondary)
                Spacer(minLength: 18)
                Text("Hi5Central RMM · iOS native preview")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 25)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { if company.isEmpty { company = state.tenant } }
    }

    private func fieldTitle(_ text: String) -> some View {
        Text(text).font(.subheadline.weight(.semibold))
    }
}

private struct InputSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct NativeOverview: View {
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Your estate").font(.title2.bold())
                    Text(client.companyName).font(.subheadline).foregroundStyle(.secondary)
                }
                LazyVGrid(columns: columns, spacing: 12) {
                    stat("Managed devices", "\(client.installedCount)", "desktopcomputer", accent)
                    stat("Online now", "\(client.onlineCount)", "checkmark.circle.fill", .green)
                    stat("Offline", "\(client.offlineDevices.count)", "wifi.slash", .orange)
                    stat("Total inventory", "\(client.devices.count)", "square.stack.3d.up", .cyan)
                }
                HStack {
                    Text("Devices").font(.title3.bold())
                    Spacer()
                    Button("View all") { state.navigate(to: .devices) }
                        .font(.subheadline.weight(.semibold))
                }
                if client.devices.isEmpty {
                    emptyState("No devices found", "Pull to refresh or check access to this tenant.", "desktopcomputer")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(client.devices.prefix(6))) { device in
                            Button { state.navigate(to: .devices) } label: {
                                deviceRow(device)
                            }
                            .buttonStyle(.plain)
                            Divider().padding(.leading, 50)
                        }
                    }
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 17))
                }
                if !client.offlineDevices.isEmpty {
                    Button { state.navigate(to: .alerts) } label: {
                        HStack {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            Text("\(client.offlineDevices.count) offline device(s) need attention")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                        .padding(15)
                        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
        .refreshable { await client.refreshDevices() }
        .task { await client.refreshDevices() }
    }

    private func stat(_ title: String, _ value: String, _ symbol: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(color)
            Text(value).font(.system(size: 30, weight: .bold, design: .rounded))
            Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 17))
    }
}

struct NativeDeviceList: View {
    @EnvironmentObject private var client: RMMClient
    @State private var search = ""
    @State private var selection: ManagedDevice?
    @State private var onlineOnly = false

    private var filtered: [ManagedDevice] {
        client.devices.filter {
            (!onlineOnly || $0.isOnline) &&
            (search.isEmpty || "\($0.name) \($0.platform) \($0.id) \($0.site)"
                .localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(filtered.count) devices").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                Toggle("Online only", isOn: $onlineOnly).font(.caption)
                    .fixedSize()
            }
            .padding(.horizontal, 16).padding(.top, 12)
            if let error = client.errorMessage {
                Text(error).foregroundStyle(.orange).font(.caption)
                    .padding(.horizontal, 16)
            }
            List {
                ForEach(filtered) { device in
                    Button { selection = device } label: {
                        deviceRow(device)
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color(uiColor: .secondarySystemBackground))
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .searchable(text: $search, prompt: "Search devices")
            .refreshable { await client.refreshDevices() }
            .overlay {
                if filtered.isEmpty {
                    emptyState("No matching devices", "Try another search or refresh.", "magnifyingglass")
                }
            }
        }
        .sheet(item: $selection) { device in
            NativeDeviceDetail(device: device)
                .environmentObject(client)
                .presentationDragIndicator(.visible)
        }
        .task { await client.refreshDevices() }
    }
}

struct NativeDeviceDetail: View {
    let device: ManagedDevice
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 15) {
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: 28)).foregroundStyle(accent)
                            .frame(width: 64, height: 64)
                            .background(accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 16))
                        VStack(alignment: .leading, spacing: 6) {
                            Text(device.name).font(.title3.bold())
                            HStack {
                                Circle().fill(device.isOnline ? Color.green : Color.orange)
                                    .frame(width: 8, height: 8)
                                Text(device.status).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    Button {
                        Task {
                            busy = true
                            defer { busy = false }
                            do {
                                let url = try await client.openRemote(for: device)
                                await client.prepareViewerCookies()
                                dismiss()
                                try? await Task.sleep(nanoseconds: 280_000_000)
                                state.showViewer(url)
                            } catch {
                                self.error = error.localizedDescription
                            }
                        }
                    } label: {
                        HStack(spacing: 9) {
                            if busy { ProgressView().tint(.white) }
                            Image(systemName: "display")
                            Text("Start remote desktop")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!device.isOnline || busy)

                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                    VStack(spacing: 0) {
                        detailRow("Reference", device.id)
                        detailRow("Operating system", device.platform)
                        detailRow("Site", device.site.isEmpty ? "Unassigned" : device.site)
                        detailRow("Assigned to", device.assignedTo.isEmpty ? "Unassigned" : device.assignedTo)
                        detailRow("CPU usage", device.cpu.map { "\($0)%" } ?? "Not reported")
                        detailRow("Memory usage", device.memory.map { "\($0)%" } ?? "Not reported")
                        detailRow("Disk usage", device.disk.map { "\($0)%" } ?? "Not reported")
                        detailRow("Patch queue", device.pendingPatches.map(String.init) ?? "Not reported")
                    }
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                    Text("Remote sessions use your existing Hi5Central permissions and encrypted WebRTC connection.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .navigationTitle("Device details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).font(.subheadline)
            Spacer()
            Text(value).font(.subheadline.weight(.medium))
                .multilineTextAlignment(.trailing)
        }
        .padding(14)
    }
}

struct NativeAlerts: View {
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Device availability").font(.title2.bold())
                    Text("Offline devices detected from the live agent inventory.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if client.offlineDevices.isEmpty {
                    emptyState("All monitored agents online", "No offline agents detected in the current inventory.", "checkmark.shield")
                } else {
                    ForEach(client.offlineDevices) { device in
                        VStack(alignment: .leading, spacing: 9) {
                            Label("Offline", systemImage: "wifi.slash")
                                .font(.caption.weight(.bold)).foregroundStyle(.orange)
                            Text(device.name).font(.headline)
                            Text(device.platform).font(.caption).foregroundStyle(.secondary)
                            Text("Last contact: " + (device.lastSeen.isEmpty ? "Not reported" : device.lastSeen))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 15))
                    }
                }
                Text("This screen currently reflects device connectivity. Monitoring policy alerts and push delivery will be connected as their native API support is added.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
        }
        .refreshable { await client.refreshDevices() }
        .task { await client.refreshDevices() }
    }
}

struct NativeMore: View {
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState
    private let items: [(String, String, RMMRoute)] = [
        ("Connect", "antenna.radiowaves.left.and.right", .connect),
        ("Patching", "checkmark.shield", .patching),
        ("Software", "square.stack.3d.up", .software),
        ("Automation", "bolt", .automation),
        ("Reports", "chart.bar", .reports),
        ("Settings", "gearshape", .settings),
        ("Profile", "person.crop.circle", .profile)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Tools").font(.title2.bold())
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 11) {
                    ForEach(items.indices, id: \.self) { index in
                        Button {
                            Task {
                                await client.prepareViewerCookies()
                                state.navigate(to: items[index].2)
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(systemName: items[index].1).font(.title2).foregroundStyle(accent)
                                Text(items[index].0).font(.subheadline.bold()).foregroundStyle(.primary)
                            }
                            .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
                            .padding(15)
                            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                        }
                        .buttonStyle(.plain)
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    Label("Notifications test", systemImage: "bell.badge").font(.headline)
                    Text("Try an actual iPhone banner and Lock Screen notification without an Apple developer subscription.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button {
                        Task { await client.sendLocalNotificationTest() }
                    } label: {
                        Label("Send test notification", systemImage: "paperplane")
                    }
                    .buttonStyle(.borderedProminent)
                    if let message = client.alertFeedback {
                        Text(message).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text("Server-sent background push is not enabled in this free-signed IPA.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 11) {
                    Text(client.userName).font(.headline)
                    Text(client.companyName).font(.subheadline).foregroundStyle(.secondary)
                    Button(role: .destructive) {
                        Task {
                            await client.signOut()
                            state.navigate(to: .dashboard)
                        }
                    } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            }
            .padding(16)
        }
    }
}

struct NativeRecoveryCodes: View {
    @EnvironmentObject private var client: RMMClient

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            Label("Save your recovery codes", systemImage: "key.horizontal")
                .font(.title2.bold())
            Text("These codes are shown once. Store them in a secure password manager before continuing.")
                .font(.subheadline).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(client.recoveryCodes, id: \.self) { code in
                        Text(code)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(15)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            Button("I've saved these codes") {
                client.finishRecoveryCodes()
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity)
        }
        .padding(22)
        .interactiveDismissDisabled()
    }
}

@ViewBuilder
func emptyState(_ title: String, _ subtitle: String, _ symbol: String) -> some View {
    VStack(spacing: 12) {
        Image(systemName: symbol).font(.system(size: 30)).foregroundStyle(accent)
        Text(title).font(.headline)
        Text(subtitle).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 34)
    .padding(.horizontal, 20)
}

@ViewBuilder
func deviceRow(_ device: ManagedDevice) -> some View {
    HStack(spacing: 12) {
        Image(systemName: "desktopcomputer")
            .font(.system(size: 20))
            .foregroundStyle(accent)
            .frame(width: 38, height: 38)
            .background(accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
        VStack(alignment: .leading, spacing: 4) {
            Text(device.name).font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary).lineLimit(1)
            Text(device.platform).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 4) {
            Circle().fill(device.isOnline ? Color.green : Color.orange)
                .frame(width: 9, height: 9)
            Text(device.status).font(.caption2).foregroundStyle(.secondary)
        }
        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
    }
    .padding(.vertical, 12)
    .padding(.horizontal, 13)
}
