import SwiftUI

/// One settings and workspace directory for the combined app.
/// The focus choice changes navigation only; it never grants product access.
struct UnifiedMoreView: View {
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState

    @AppStorage("hi5central.mobile.workspaceFocus") private var focus = "all"
    @AppStorage("hi5central.mobile.appearance") private var appearance = "system"
    @State private var showingSignOut = false

    private var hasITSM: Bool { auth.hasITSM && itsm.authenticated }
    private var hasRMM: Bool { auth.hasRMM && rmm.authenticated }

    var body: some View {
        List {
            if hasITSM && hasRMM {
                Section {
                    Picker("Navigation focus", selection: $focus) {
                        Text("Combined").tag("all")
                        Text("Service Desk").tag("itsm")
                        Text("Remote Monitoring").tag("rmm")
                    }
                } header: {
                    Text("Workspace preference")
                } footer: {
                    Text("Combined shows records, devices and tasks in one navigation bar. Focus modes rearrange the tabs, but you remain signed in to both products.")
                }
            }

            if hasITSM {
                Section("Service Desk") {
                    NavigationLink {
                        ITSMApprovalsView()
                    } label: {
                        Label("Approvals", systemImage: "checkmark.shield")
                    }
                    NavigationLink {
                        ITSMDirectoryView()
                    } label: {
                        Label("People and teams", systemImage: "person.2")
                    }
                    NavigationLink {
                        ITSMCMDBView()
                    } label: {
                        Label("CMDB", systemImage: "server.rack")
                    }
                    NavigationLink {
                        ITSMProjectsView()
                    } label: {
                        Label("Projects", systemImage: "square.stack.3d.up")
                    }
                    NavigationLink {
                        ITSMCalendarView()
                    } label: {
                        Label("Calendar", systemImage: "calendar")
                    }
                    NavigationLink {
                        ITSMKnowledgeView()
                    } label: {
                        Label("Knowledge", systemImage: "books.vertical")
                    }
                    NavigationLink {
                        ITSMNotificationsView()
                    } label: {
                        Label("Notifications", systemImage: "bell.badge")
                    }
                }
            }

            if hasRMM {
                Section("Remote Monitoring") {
                    NavigationLink {
                        UnifiedDeviceHub()
                    } label: {
                        Label("Device inventory", systemImage: "desktopcomputer")
                    }
                    NavigationLink {
                        NativeAlerts()
                    } label: {
                        Label("Device alerts", systemImage: "bell")
                    }
                    NavigationLink {
                        UnifiedRMMToolHub()
                    } label: {
                        Label("RMM management tools", systemImage: "wrench.and.screwdriver")
                    }
                }
            }

            Section("Account") {
                LabeledContent("Company", value: auth.companyName)
                LabeledContent("Signed in as", value: auth.userName)
                HStack {
                    Text("Modules")
                    Spacer()
                    Text([hasITSM ? "ITSM" : nil, hasRMM ? "RMM" : nil]
                        .compactMap { $0 }.joined(separator: " + "))
                        .foregroundStyle(.secondary)
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
                    showingSignOut = true
                }
            }
            Section {
                Text("Hi5Central Mobile v0.2.0 — native integrated ITSM + RMM. Access is controlled by your tenant subscription and staff permissions.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("More")
        .confirmationDialog("Sign out of Hi5Central?",
                            isPresented: $showingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task { await auth.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

/// Keeps every existing native RMM management feature available without a
/// persistent product switcher. No WebView replacements or new APIs.
struct UnifiedRMMToolHub: View {
    var body: some View {
        List {
            Section("Remote management") {
                NavigationLink {
                    NativeConnect()
                } label: {
                    Label("Remote Connect", systemImage: "antenna.radiowaves.left.and.right")
                }
                NavigationLink {
                    NativePatching()
                } label: {
                    Label("Patching", systemImage: "checkmark.shield")
                }
                NavigationLink {
                    NativeSoftware()
                } label: {
                    Label("Software", systemImage: "shippingbox")
                }
                NavigationLink {
                    NativeAutomation()
                } label: {
                    Label("Automation", systemImage: "bolt")
                }
                NavigationLink {
                    NativeReports()
                } label: {
                    Label("Reports", systemImage: "chart.bar")
                }
                NavigationLink {
                    NativeSettings()
                } label: {
                    Label("RMM settings", systemImage: "gearshape")
                }
            }
            Section {
                Text("For PowerShell, CMD, File Browser, Services, Task Manager and Registry Editor, select a device first.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("RMM tools")
    }
}
