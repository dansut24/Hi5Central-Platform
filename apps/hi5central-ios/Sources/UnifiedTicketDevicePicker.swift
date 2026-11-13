import SwiftUI

/// Open remote support from a ticket without guessing associations. Only an
/// explicit device identifier is treated as linked; otherwise technicians
/// search the authenticated tenant RMM inventory manually.
struct UnifiedTicketDevicePicker: View {
    let record: ITSMRecord

    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var selected: ManagedDevice?

    private var linkedId: String {
        for key in ["linkedDeviceId", "rmmDeviceId", "deviceId"] {
            let value = itsmString(record.raw[key])
            if UUID(uuidString: value) != nil { return value }
        }
        return ""
    }
    private var linked: ManagedDevice? {
        guard !linkedId.isEmpty else { return nil }
        return rmm.devices.first { $0.agentId == linkedId || $0.id == linkedId }
    }
    private var devices: [ManagedDevice] {
        guard !query.isEmpty else { return Array(rmm.devices.prefix(40)) }
        return Array(rmm.devices.filter {
            [$0.name, $0.id, $0.agentId, $0.site, $0.platform]
                .joined(separator: " ")
                .localizedCaseInsensitiveContains(query)
        }.prefix(80))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Remote support for \(record.id)")
                            .font(.headline)
                        Text("Select a device from your authorised company inventory. The remote session uses the existing native RMM viewer.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let linked {
                    Section("Linked device") {
                        deviceButton(linked)
                    }
                }
                Section("Company devices") {
                    if devices.isEmpty {
                        Label("No accessible devices match your search.",
                              systemImage: "desktopcomputer")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(devices) { device in
                        if device.agentId != linked?.agentId || linked == nil {
                            deviceButton(device)
                        }
                    }
                }
                if linked == nil {
                    Section {
                        Text("No explicit linked RMM device is attached to this record. Choose the correct endpoint; do not infer the relationship from similar names.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .searchable(text: $query, prompt: "Find a device")
            .navigationTitle("Remote support")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $selected) { device in
                NativeDeviceDetail(device: device)
                    .environmentObject(rmm)
                    .environmentObject(rmmState)
            }
            .task {
                if rmm.devices.isEmpty { await rmm.refreshDevices() }
            }
        }
    }

    private func deviceButton(_ device: ManagedDevice) -> some View {
        Button { selected = device } label: {
            HStack(spacing: 11) {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(device.platform)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(device.isOnline ? "Online" : "Offline")
                    .font(.caption2)
                    .foregroundStyle(device.isOnline ? Color.green : Color.orange)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
