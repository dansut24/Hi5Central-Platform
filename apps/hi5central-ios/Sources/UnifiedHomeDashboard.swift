import SwiftUI
import Charts

/// Combined home contains only values returned for this authenticated
/// tenant and this user's permitted modules. No synthetic history is shown.
struct UnifiedHomeDashboard: View {
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient

    let showITSM: Bool
    let showRMM: Bool
    let openRecords: () -> Void
    let openDevices: () -> Void
    let openTasks: () -> Void
    let openAlerts: () -> Void
    let newRecord: () -> Void
    let findDevice: () -> Void
    let openApprovals: () -> Void
    let openSearch: () -> Void

    @State private var selectedRecord: ITSMRecord?
    @State private var selectedDevice: ManagedDevice?

    private var visibleOpenWork: Int {
        itsm.records.filter(\.isOpen).count
    }
    private var reportedOpenWork: Int? {
        (itsm.report["open"] as? NSNumber)?.intValue
    }
    private var reportedTotal: Int? {
        (itsm.report["total"] as? NSNumber)?.intValue
    }
    private var recentRecords: [ITSMRecord] { Array(itsm.records.prefix(4)) }
    private var offlineDevices: [ManagedDevice] { Array(rmm.offlineDevices.prefix(4)) }
    private var pendingTasks: Int {
        itsm.tasks.filter {
            !["Completed", "Cancelled", "Closed"].contains($0.status)
        }.count
    }

    private struct Workload: Identifiable {
        var id: String { title }
        let title: String
        let count: Int
        let group: String
    }

    private var chartData: [Workload] {
        var data: [Workload] = []
        if showITSM {
            data.append(Workload(title: "Open work", count: reportedOpenWork ?? visibleOpenWork,
                                group: "Service Desk"))
            data.append(Workload(title: "Tasks", count: pendingTasks, group: "Service Desk"))
        }
        if showRMM {
            data.append(Workload(title: "Online", count: rmm.onlineCount,
                                group: "Remote Monitoring"))
            data.append(Workload(title: "Offline", count: rmm.offlineDevices.count,
                                group: "Remote Monitoring"))
        }
        return data
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your workspace").font(.title2.weight(.bold))
                    Text("Tickets, devices and today's priorities in one place")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                UnifiedQuickLaunch(
                    hasITSM: showITSM,
                    hasRMM: showRMM,
                    newRecord: newRecord,
                    findDevice: findDevice,
                    approvals: openApprovals,
                    search: openSearch
                )

                UnifiedAttentionPanel(
                    hasITSM: showITSM,
                    hasRMM: showRMM,
                    showApprovals: openApprovals,
                    showDevices: openDevices
                )

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 11) {
                    if showITSM {
                        statCard("Open work", value: String(reportedOpenWork ?? visibleOpenWork),
                                 detail: reportedOpenWork == nil ? "Visible to you" : "Service Desk",
                                 symbol: "tray.full.fill", color: .orange, action: openRecords)
                        statCard("Tasks", value: String(pendingTasks),
                                 detail: "Accessible active tasks",
                                 symbol: "checklist", color: .blue, action: openTasks)
                    }
                    if showRMM {
                        statCard("Online devices", value: String(rmm.onlineCount),
                                 detail: "Connected agents",
                                 symbol: "desktopcomputer", color: .green, action: openDevices)
                        statCard("Offline devices", value: String(rmm.offlineDevices.count),
                                 detail: "Check connectivity",
                                 symbol: "wifi.slash", color: .orange, action: openAlerts)
                    }
                }

                if !chartData.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Workload and availability", systemImage: "chart.bar.xaxis")
                            .font(.headline)
                        Chart(chartData) { point in
                            BarMark(
                                x: .value("Count", point.count),
                                y: .value("Metric", point.title)
                            )
                            .foregroundStyle(by: .value("Workspace", point.group))
                            .annotation(position: .trailing) {
                                Text("\(point.count)")
                                    .font(.caption2.weight(.medium))
                            }
                        }
                        .frame(height: CGFloat(max(130, chartData.count * 42)))
                        .chartLegend(position: .bottom)
                        Text("Live counts from the permitted ITSM and RMM APIs. Reporting totals are only shown when authorised.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .unifiedPanel()
                }

                if showITSM {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label("Recent records", systemImage: "ticket")
                                .font(.headline)
                            Spacer()
                            Button("See all", action: openRecords)
                                .font(.caption)
                        }
                        if recentRecords.isEmpty {
                            Text("No accessible records found.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(recentRecords) { record in
                                Button { selectedRecord = record } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(record.id)
                                                .font(.caption.weight(.bold))
                                                .foregroundStyle(.tint)
                                            Text(record.title)
                                                .font(.subheadline.weight(.medium))
                                                .foregroundStyle(.primary)
                                                .lineLimit(2)
                                        }
                                        Spacer(minLength: 6)
                                        Text(record.status)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                        Image(systemName: "chevron.right")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                .buttonStyle(.plain)
                                if record.id != recentRecords.last?.id { Divider() }
                            }
                        }
                    }
                    .unifiedPanel()
                }

                if showRMM {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label("Devices requiring attention", systemImage: "exclamationmark.triangle")
                                .font(.headline)
                            Spacer()
                            Button("View devices", action: openDevices)
                                .font(.caption)
                        }
                        if offlineDevices.isEmpty {
                            Label("No offline agents in your accessible inventory.",
                                  systemImage: "checkmark.circle")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(offlineDevices) { device in
                                Button { selectedDevice = device } label: {
                                    HStack(spacing: 9) {
                                        Image(systemName: "desktopcomputer")
                                            .foregroundStyle(.orange)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(device.name)
                                                .font(.subheadline.weight(.medium))
                                                .foregroundStyle(.primary)
                                            Text(device.platform)
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text("Offline")
                                            .font(.caption)
                                            .foregroundStyle(.orange)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .unifiedPanel()
                }

                if showITSM && showRMM {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Your workspaces").font(.headline)
                        HStack(spacing: 10) {
                            workspaceCard("Service Desk", symbol: "headphones",
                                          detail: reportedTotal.map { "\($0) total records" }
                                               ?? "Records, approvals and tasks",
                                          action: openRecords)
                            workspaceCard("Remote Monitoring", symbol: "monitor",
                                          detail: "\(rmm.installedCount) managed agents",
                                          action: openDevices)
                        }
                    }
                }
            }
            .padding(.horizontal, 15)
            .padding(.top, 12)
            .padding(.bottom, 26)
        }
        .refreshable {
            async let a: Void = showITSM ? itsm.refreshAll() : ()
            async let b: Void = showRMM ? rmm.refreshDevices() : ()
            _ = await (a,b)
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $selectedRecord) { record in
            ITSMRecordDetail(record: record)
                .environmentObject(itsm)
        }
        .sheet(item: $selectedDevice) { device in
            NativeDeviceDetail(device: device)
                .environmentObject(rmm)
        }
    }

    private func statCard(_ label: String, value: String, detail: String,
                          symbol: String, color: Color,
                          action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(color)
                Text(value)
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .foregroundStyle(.primary)
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
            .padding(13)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label): \(value), \(detail)")
    }

    private func workspaceCard(_ title: String, symbol: String, detail: String,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(.tint)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
            .padding(13)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }
}

private extension View {
    func unifiedPanel() -> some View {
        self.padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 16))
    }
}
