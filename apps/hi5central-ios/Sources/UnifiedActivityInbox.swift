import SwiftUI

/// A single in-app activity inbox for subscription-authorised ITSM notices
/// and live RMM connectivity signals. This is not APNs push notification
/// delivery or a full RMM policy alert history.
struct UnifiedActivityInbox: View {
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var rmmState: RMMState
    @Environment(\.dismiss) private var dismiss

    @State private var category = "all"
    @State private var selectedRecord: ITSMRecord?
    @State private var selectedDevice: ManagedDevice?

    private var hasITSM: Bool { auth.hasITSM && itsm.authenticated }
    private var hasRMM: Bool { auth.hasRMM && rmm.authenticated }
    private var displayITSM: Bool { hasITSM && category != "devices" }
    private var displayRMM: Bool { hasRMM && category != "itsm" }
    private var unread: Int {
        itsm.notifications.filter { ($0["read"] as? Bool) != true }.count
    }

    private func matchedRecord(for notice: [String: Any]) -> ITSMRecord? {
        let references = ["recordId", "record_id", "recordReference", "reference"]
        for field in references {
            let value = itsmString(notice[field])
            if !value.isEmpty, let match = itsm.records.first(where: {
                $0.id.caseInsensitiveCompare(value) == .orderedSame
            }) {
                return match
            }
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            List {
                if hasITSM && hasRMM {
                    Section {
                        Picker("Activity filter", selection: $category) {
                            Text("All").tag("all")
                            Text("ITSM").tag("itsm")
                            Text("Devices").tag("devices")
                        }
                        .pickerStyle(.segmented)
                    }
                }

                if displayITSM {
                    Section {
                        if itsm.notifications.isEmpty {
                            Label("No service desk notifications",
                                  systemImage: "bell.slash")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                        } else {
                            ForEach(Array(itsm.notifications.prefix(80).enumerated()),
                                    id: \.offset) { item in
                                notificationRow(item.element)
                            }
                        }
                    } header: {
                        HStack {
                            Text("Service Desk")
                            Spacer()
                            Text("\(unread) unread")
                                .font(.caption2)
                        }
                    } footer: {
                        Text("These are in-app notifications from your ITSM tenant.")
                    }
                }

                if displayRMM {
                    Section {
                        if rmm.offlineDevices.isEmpty {
                            Label("No offline agents reported",
                                  systemImage: "checkmark.circle")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                        } else {
                            ForEach(rmm.offlineDevices) { device in
                                Button { selectedDevice = device } label: {
                                    HStack(alignment: .top, spacing: 11) {
                                        Image(systemName: "wifi.slash")
                                            .foregroundStyle(.orange)
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(device.name)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(.primary)
                                            Text("Agent offline")
                                                .font(.caption)
                                                .foregroundStyle(.orange)
                                            if !device.lastSeen.isEmpty {
                                                Text("Last seen: " + device.lastSeen)
                                                    .font(.caption2)
                                                    .foregroundStyle(.secondary)
                                                    .lineLimit(2)
                                            }
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    } header: {
                        Text("RMM connectivity · \(rmm.offlineDevices.count)")
                    } footer: {
                        Text("Connectivity is based on live agent inventory. Monitoring-policy alert history is not yet integrated.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { await refresh() }
            .sheet(item: $selectedRecord) { record in
                ITSMRecordDetail(record: record).environmentObject(itsm)
            }
            .sheet(item: $selectedDevice) { device in
                NativeDeviceDetail(device: device)
                    .environmentObject(rmm)
                    .environmentObject(rmmState)
            }
        }
    }

    private func notificationRow(_ notice: [String: Any]) -> some View {
        Button {
            Task {
                if let record = matchedRecord(for: notice) {
                    selectedRecord = record
                }
                await itsm.markNotificationRead(notice)
            }
        } label: {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: (notice["read"] as? Bool) == true
                      ? "bell" : "bell.badge.fill")
                    .foregroundStyle((notice["read"] as? Bool) == true
                                     ? Color.secondary : Color.accentColor)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 5) {
                    Text(itsmString(notice["title"]).isEmpty
                         ? "Hi5Central notification" : itsmString(notice["title"]))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    let body = itsmString(notice["body"])
                    if !body.isEmpty {
                        Text(body)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    let date = itsmString(notice["createdAt"])
                    if !date.isEmpty {
                        Text(itsmDate(date))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 3)
                if matchedRecord(for: notice) != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }

    private func refresh() async {
        if hasITSM { await itsm.refreshNotifications() }
        if hasRMM { await rmm.refreshDevices() }
    }
}
