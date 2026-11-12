import SwiftUI

/// Search is available from every native workspace, without changing
/// the selected tab or introducing a web view.
struct NativeGlobalSearch: View {
    @EnvironmentObject private var state: RMMState
    @EnvironmentObject private var client: RMMClient
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var selected: ManagedDevice?
    @State private var recentActivity: [[String: Any]] = []

    private var routes: [(String, String, String, RMMRoute)] {
        [
            ("Overview", "Dashboard, devices and telemetry", "chart.bar", .dashboard),
            ("Devices", "Inventory and remote management", "desktopcomputer", .devices),
            ("Alerts", "Device connectivity alerts", "bell", .alerts),
            ("Patching", "Update policies and deployment", "checkmark.shield", .patching),
            ("Software", "Applications and catalogue", "shippingbox", .software),
            ("Automation", "Scripts and scheduled jobs", "gearshape.2", .automation),
            ("Remote Connect", "Remote desktop sessions", "display", .connect),
            ("Reports", "Fleet and activity reports", "chart.bar.xaxis", .reports),
            ("Settings", "Appearance and preferences", "gearshape", .settings),
            ("My profile", "User and account settings", "person.crop.circle", .profile)
        ]
    }

    private var cleanQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func matches(_ values: String...) -> Bool {
        cleanQuery.isEmpty || values.joined(separator: " ").localizedCaseInsensitiveContains(cleanQuery)
    }

    private var devices: [ManagedDevice] {
        client.devices.filter {
            matches($0.name, $0.platform, $0.site, $0.id,
                    $0.assignedTo, $0.status,
                    $0.isOnline ? "online remote" : "offline")
        }
    }

    private var destinations: [(String, String, String, RMMRoute)] {
        routes.filter { matches($0.0, $0.1) }
    }

    private var activities: [[String: Any]] {
        guard !cleanQuery.isEmpty else { return [] }
        return recentActivity.filter {
            matches(nativeText($0, ["summary"]), nativeText($0, ["detail"]),
                    nativeText($0, ["device_name"]), nativeText($0, ["category"]))
        }.prefix(12).map { $0 }
    }

    var body: some View {
        NavigationStack {
            List {
                if !destinations.isEmpty {
                    Section("Pages & workspaces") {
                        ForEach(destinations, id: \.0) { destination in
                            Button {
                                state.navigate(to: destination.3)
                                dismiss()
                            } label: {
                                Label {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(destination.0).font(.subheadline.weight(.semibold))
                                        Text(destination.1).font(.caption).foregroundStyle(.secondary)
                                    }
                                } icon: {
                                    Image(systemName: destination.2)
                                        .frame(width: 30)
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }

                if !devices.isEmpty {
                    Section("Devices · \(devices.count)") {
                        ForEach(Array(devices.prefix(45))) { device in
                            Button { selected = device } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "desktopcomputer")
                                        .foregroundStyle(.secondary)
                                        .frame(width: 25)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(device.name).font(.subheadline.weight(.medium))
                                        Text("\(device.platform) · \(device.site.isEmpty ? device.status : device.site)")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Circle()
                                        .fill(device.isOnline ? Color.green : Color.orange)
                                        .frame(width: 8, height: 8)
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }

                if !activities.isEmpty {
                    Section("Recent activity") {
                        ForEach(Array(activities.enumerated()), id: \.offset) { _, event in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(nativeText(event, ["summary"]))
                                    .font(.subheadline.weight(.medium))
                                Text(nativeText(event, ["device_name", "category"]))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !cleanQuery.isEmpty && destinations.isEmpty && devices.isEmpty && activities.isEmpty {
                    ContentUnavailableView.search(text: cleanQuery)
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Search devices, actions, pages, activity")
            .navigationTitle("Search Hi5Central")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $selected) { device in
                NativeDeviceDetail(device: device).environmentObject(client)
                    .environmentObject(state)
            }
            .task {
                // The activity API has its own audit permission. Search still
                // works for devices/pages even when the user cannot access it.
                if let data = try? await client.nativeRead(.activity) {
                    recentActivity = nativeRows(data["events"])
                }
            }
        }
    }
}
