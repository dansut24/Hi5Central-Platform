import SwiftUI

@main
struct Hi5CentralITSMApp: App {
    @StateObject private var client = ITSMClient()

    var body: some Scene {
        WindowGroup {
            ITSMRootView()
                .environmentObject(client)
                .tint(Color(red: 0.16, green: 0.47, blue: 0.94))
        }
    }
}

struct ITSMRootView: View {
    @EnvironmentObject private var client: ITSMClient
    @AppStorage("hi5central.itsm.lastTenant") private var savedTenant = ""
    @AppStorage("hi5central.itsm.appearance") private var appearance = "system"
    @State private var starting = true
    @State private var searching = false

    var body: some View {
        Group {
            if starting {
                splash
            } else if client.authenticated {
                workspace
            } else {
                ITSMLogin()
            }
        }
        .preferredColorScheme(appearance == "light" ? .light
                              : appearance == "dark" ? .dark : nil)
        .sheet(isPresented: Binding(get: { !client.recoveryCodes.isEmpty },
                                    set: { if !$0 { client.clearRecoveryCodes() } })) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Label("Save your recovery codes", systemImage: "lock.shield")
                            .font(.title3.bold())
                        Text("Keep these codes somewhere private. Each can be used if you lose access to your authenticator.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        ForEach(client.recoveryCodes, id: \.self) { code in
                            Text(code).font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(9)
                                .background(Color(uiColor: .secondarySystemBackground),
                                            in: RoundedRectangle(cornerRadius: 8))
                        }
                        Button("I've saved these codes") { client.clearRecoveryCodes() }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(18)
                }
                .navigationTitle("Recovery codes")
            }
        }
        .task {
            await client.restore(savedTenant)
            starting = false
        }
    }

    private var splash: some View {
        ZStack {
            Color(red: 0.027, green: 0.045, blue: 0.083).ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                ITSMBrand(size: 96)
                Text("Hi5Central")
                    .font(.system(size: 32, weight: .bold))
                Text("IT SERVICE MANAGEMENT")
                    .font(.caption.weight(.bold))
                    .tracking(2)
                    .foregroundStyle(.white.opacity(0.65))
                Spacer()
                ProgressView().tint(.white)
                Text("Your service desk, wherever you are")
                    .font(.caption).foregroundStyle(.white.opacity(0.60))
            }
            .foregroundStyle(.white)
            .padding(25)
        }
    }

    private var workspace: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                ITSMBrand(size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hi5Central ITSM")
                        .font(.system(size: 15, weight: .bold))
                    Text(client.companyName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    searching = true
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 19))
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel("Search all ITSM workspaces")
                Button {
                    Task { await client.refreshAll() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 17))
                        .frame(width: 34, height: 36)
                }
                .accessibilityLabel("Refresh ITSM")
            }
            .padding(.horizontal, 15)
            .frame(height: 54)
            Divider()
            TabView {
                NavigationStack { ITSMDashboard() }
                    .tabItem { Label("Home", systemImage: "house") }
                NavigationStack { ITSMRecordsView() }
                    .tabItem { Label("Records", systemImage: "tray.full") }
                NavigationStack { ITSMTasksView() }
                    .tabItem { Label("Tasks", systemImage: "checklist") }
                NavigationStack { ITSMKnowledgeView() }
                    .tabItem { Label("Knowledge", systemImage: "books.vertical") }
                NavigationStack { ITSMMoreView() }
                    .tabItem { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .background(Color(uiColor: .systemBackground))
        .sheet(isPresented: $searching) {
            ITSMGlobalSearch().environmentObject(client)
        }
    }
}

struct ITSMLogin: View {
    @EnvironmentObject private var client: ITSMClient
    @AppStorage("hi5central.itsm.lastTenant") private var savedTenant = ""
    @State private var company = ""
    @State private var email = ""
    @State private var password = ""
    @State private var otp = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    ITSMBrand(size: 65)
                    Spacer()
                    Text("ITSM")
                        .font(.caption.bold())
                        .tracking(2)
                        .foregroundStyle(.tint)
                        .padding(9)
                        .background(Color.accentColor.opacity(0.10), in: Capsule())
                }
                .padding(.top, 24)

                VStack(alignment: .leading, spacing: 7) {
                    Text(client.challenge == nil ? "Welcome back" : "Verify your identity")
                        .font(.largeTitle.bold())
                    Text(client.challenge == nil
                         ? "Sign in to your Hi5Central service desk."
                         : "Enter your authenticator or recovery code to continue.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 17) {
                    if client.challenge == nil {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Company").font(.subheadline.weight(.semibold))
                            HStack(spacing: 3) {
                                TextField("company", text: $company)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                Text(".hi5central.com")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .itsmInput()
                        }

                        VStack(alignment: .leading, spacing: 5) {
                            Text("Work email").font(.subheadline.weight(.semibold))
                            TextField("you@company.com", text: $email)
                                .textContentType(.username)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .itsmInput()
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Password").font(.subheadline.weight(.semibold))
                            SecureField("Password", text: $password)
                                .textContentType(.password)
                                .itsmInput()
                        }
                        Button {
                            Task {
                                await client.signIn(tenant: company, email: email,
                                                    password: password)
                                password = ""
                                if client.authenticated { savedTenant = client.tenant }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                if client.busy { ProgressView().tint(.white) }
                                Text("Sign in")
                                Image(systemName: "arrow.right")
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(client.busy || company.isEmpty || email.isEmpty || password.isEmpty)
                    } else {
                        if let secret = client.setupSecret {
                            VStack(alignment: .leading, spacing: 7) {
                                Label("Set up your authenticator", systemImage: "lock.shield")
                                    .font(.headline)
                                Text("Save this secret in your authenticator app.")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(secret).font(.system(.subheadline, design: .monospaced))
                                    .textSelection(.enabled)
                                    .itsmInput()
                                if let uri = client.setupURI, let url = URL(string: uri) {
                                    ShareLink("Share setup link", item: url)
                                        .font(.caption)
                                }
                            }
                        }
                        TextField("Authenticator or recovery code", text: $otp)
                            .textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .itsmInput()
                        Button {
                            Task {
                                await client.verifyMFA(otp.trimmingCharacters(in: .whitespacesAndNewlines))
                                if client.authenticated { savedTenant = client.tenant }
                            }
                        } label: {
                            HStack(spacing: 7) {
                                if client.busy { ProgressView().tint(.white) }
                                Text("Verify and continue")
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(otp.isEmpty || client.busy)
                        Button("Back to sign in") { client.cancelMFA(); otp = "" }
                    }

                    if let issue = client.errorMessage {
                        Label(issue, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(19)
                .background(Color(uiColor: .secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 19))

                Label("Your password is never stored on this device. Hi5Central's existing MFA and tenant permissions remain required.",
                      systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("Hi5Central ITSM · native iOS preview")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
            }
            .padding(22)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear {
            if company.isEmpty { company = savedTenant }
        }
    }
}

private extension View {
    func itsmInput() -> some View {
        padding(14)
            .background(Color(uiColor: .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 12))
    }
}
