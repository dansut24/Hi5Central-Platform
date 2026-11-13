import SwiftUI

/// Compact primary actions available from the unified dashboard.
/// Each action is intentionally explicit and permission gated.
struct UnifiedQuickLaunch: View {
    let hasITSM: Bool
    let hasRMM: Bool
    let newRecord: () -> Void
    let findDevice: () -> Void
    let approvals: () -> Void
    let search: () -> Void

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Text("Quick actions")
                    .font(.headline)
                Spacer()
                Image(systemName: "bolt.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            LazyVGrid(columns: columns, spacing: 10) {
                if hasITSM {
                    action("New ticket", icon: "plus.app", color: .blue,
                           description: "Incident, problem or change",
                           action: newRecord)
                }
                if hasRMM {
                    action("Remote support", icon: "desktopcomputer.and.arrow.down", color: .teal,
                           description: "Find and control a device",
                           action: findDevice)
                }
                if hasITSM {
                    action("Approvals", icon: "checkmark.shield", color: .orange,
                           description: "Review service requests",
                           action: approvals)
                }
                action("Search all", icon: "magnifyingglass", color: .indigo,
                       description: "Tickets, devices and more",
                       action: search)
            }
        }
    }

    private func action(_ label: String, icon: String, color: Color,
                        description: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(color)
                    .frame(width: 32, height: 34)
                    .background(color.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 4) {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(description)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }
}

/// Immediate actionable work is more useful than placing graphs at the top of
/// a phone. Counts are explicitly *visible* records, not tenant-wide totals.
struct UnifiedAttentionPanel: View {
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState

    let hasITSM: Bool
    let hasRMM: Bool
    let showApprovals: () -> Void
    let showDevices: () -> Void

    @State private var chosenRecord: ITSMRecord?
    @State private var chosenDevice: ManagedDevice?

    private var priorityRecords: [ITSMRecord] {
        hasITSM ? Array(itsm.records.filter {
            $0.isOpen && ["High", "Critical"].contains($0.priority)
        }.prefix(3)) : []
    }
    private var approvalCount: Int {
        guard hasITSM else { return 0 }
        return itsm.records.filter(\.isServiceRequest).reduce(0) { sum, record in
            sum + record.approvals.filter {
                itsmString($0["status"]) == "Pending"
            }.count
        }
    }
    private var offline: [ManagedDevice] {
        hasRMM ? Array(rmm.offlineDevices.prefix(3)) : []
    }

    var body: some View {
        if !priorityRecords.isEmpty || approvalCount > 0 || !offline.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Needs attention", systemImage: "exclamationmark.circle.fill")
                        .font(.headline)
                    Spacer()
                    Text("From your accessible work")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                ForEach(priorityRecords) { record in
                    Button { chosenRecord = record } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "ticket")
                                .foregroundStyle(record.priority == "Critical"
                                                 ? Color.red : Color.orange)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(record.title)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text("\(record.id) · \(record.priority) priority")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    Divider()
                }

                if approvalCount > 0 {
                    Button(action: showApprovals) {
                        HStack(spacing: 10) {
                            Image(systemName: "checkmark.shield")
                                .foregroundStyle(.orange).frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Pending approvals")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                Text("\(approvalCount) visible requests awaiting decisions")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    Divider()
                }

                ForEach(offline) { device in
                    Button { chosenDevice = device } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "wifi.slash")
                                .foregroundStyle(.orange).frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(device.name)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                Text("RMM agent offline")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if hasRMM && rmm.offlineDevices.count > 3 {
                    Button("See all offline devices", action: showDevices)
                        .font(.caption)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 16))
            .sheet(item: $chosenRecord) { record in
                ITSMRecordDetail(record: record).environmentObject(itsm)
            }
            .sheet(item: $chosenDevice) { device in
                NativeDeviceDetail(device: device)
                    .environmentObject(rmm)
                    .environmentObject(rmmState)
            }
        }
    }
}
