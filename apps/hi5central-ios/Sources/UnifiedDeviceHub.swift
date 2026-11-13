import SwiftUI

/// Native device workbench for the combined app. Does not change the
/// standalone RMM app or any WebRTC/Agent implementation.
struct UnifiedDeviceHub: View {
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState

    @State private var query = ""
    @State private var filter = "All"
    @State private var sort = "Name"
    @State private var selected: ManagedDevice?
    @State private var errorMessage: String?
    @State private var connectingId: String?

    private var filtered: [ManagedDevice] {
        let devices = rmm.devices.filter { device in
            let stateMatches = filter == "All"
                || (filter == "Online" && device.isOnline)
                || (filter == "Offline" && device.hasAgent && !device.isOnline)
                || (filter == "Inventory" && !device.hasAgent)
            let textMatches = query.isEmpty
                || [device.name, device.id, device.agentId, device.platform,
                    device.site, device.assignedTo].joined(separator: " ")
                    .localizedCaseInsensitiveContains(query)
            return stateMatches && textMatches
        }
        return devices.sorted { a, b in
            if sort == "Status" && a.isOnline != b.isOnline {
                return a.isOnline && !b.isOnline
            }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                metric("Online", count: rmm.onlineCount, color: .green)
                metric("Offline", count: rmm.offlineDevices.count, color: .orange)
                metric("Total", count: rmm.devices.count, color: .blue)
            }
            .padding(.horizontal, 14)
            .padding(.top, 9)

            Picker("Device availability", selection: $filter) {
                Text("All").tag("All")
                Text("Online").tag("Online")
                Text("Offline").tag("Offline")
                Text("Inventory").tag("Inventory")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 9)

            List {
                Section {
                    if filtered.isEmpty {
                        Label(query.isEmpty ? "No matching devices" : "No search results",
                              systemImage: "desktopcomputer")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(filtered) { device in
                        Button { selected = device } label: {
                            HStack(spacing: 12) {
                                Image(systemName: device.hasAgent
                                      ? "desktopcomputer" : "square.stack.3d.up")
                                    .font(.system(size: 20))
                                    .frame(width: 35, height: 37)
                                    .foregroundStyle(device.isOnline ? Color.green : Color.secondary)
                                    .background(Color(uiColor: .tertiarySystemBackground),
                                                in: RoundedRectangle(cornerRadius: 9))
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(device.name)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                        .lineLimit(2)
                                    Text([device.platform, device.site]
                                        .filter { !$0.isEmpty }.joined(separator: " · "))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    if !device.assignedTo.isEmpty {
                                        Text("Assigned: " + device.assignedTo)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 5)
                                VStack(alignment: .trailing, spacing: 8) {
                                    Circle()
                                        .fill(device.isOnline ? Color.green :
                                              device.hasAgent ? Color.orange : Color.gray)
                                        .frame(width: 9, height: 9)
                                    if connectingId == device.id {
                                        ProgressView().controlSize(.mini)
                                    } else {
                                        Image(systemName: "chevron.right")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if device.isOnline {
                                Button {
                                    Task { await connect(to: device) }
                                } label: {
                                    Label("Remote", systemImage: "display")
                                }
                                .tint(.blue)
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("\(filtered.count) devices")
                        Spacer()
                        Menu {
                            Button("Name", systemImage: "textformat.abc") { sort = "Name" }
                            Button("Online first", systemImage: "wifi") { sort = "Status" }
                        } label: {
                            Label("Sort", systemImage: "arrow.up.arrow.down")
                                .font(.caption)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search name, site, person or device")
        .refreshable { await rmm.refreshDevices() }
        .task { if rmm.devices.isEmpty { await rmm.refreshDevices() } }
        .sheet(item: $selected) { device in
            NativeDeviceDetail(device: device)
                .environmentObject(rmm)
                .environmentObject(rmmState)
        }
        .alert("Remote support", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func metric(_ name: String, count: Int, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(String(count))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(name)
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(9)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 11))
    }

    private func connect(to device: ManagedDevice) async {
        guard device.isOnline, connectingId == nil else { return }
        connectingId = device.id
        defer { connectingId = nil }
        do {
            let url = try await rmm.openRemote(for: device)
            rmmState.showViewer(url)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
