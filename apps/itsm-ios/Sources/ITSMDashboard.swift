import SwiftUI
import Charts

private let itsmAccent = Color(red: 0.16, green: 0.47, blue: 0.94)

struct ITSMBrand: View {
    var size: CGFloat = 42
    var body: some View {
        Image("Hi5CentralLogo")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel("Hi5Central logo")
    }
}

private struct ChartCount: Identifiable {
    let label: String
    let value: Int
    var id: String { label }
}

struct ITSMDashboard: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var selected: ITSMRecord?

    private var canReport: Bool { client.report["total"] != nil }
    private var byPriority: [ChartCount] {
        itsmDict(client.report["byPriority"])
            .map { ChartCount(label: $0.key, value: (itsmDict(client.report["byPriority"])[$0.key] as? NSNumber)?.intValue ?? 0) }
            .sorted { $0.value > $1.value }
    }
    private var byType: [ChartCount] {
        itsmDict(client.report["byType"])
            .map { ChartCount(label: $0.key, value: ($0.value as? NSNumber)?.intValue ?? 0) }
            .sorted { $0.value > $1.value }
    }
    private var trend: [(String, Int)] {
        itsmRows(client.report["trend"])
            .map { (itsmString($0["day"]), ($0["count"] as? NSNumber)?.intValue ?? 0) }
            .filter { !$0.0.isEmpty }
    }
    private var recent: [ITSMRecord] { Array(client.records.prefix(6)) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Service Desk")
                        .font(.title2.weight(.bold))
                    Text("Your service desk at a glance")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if canReport {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 11) {
                        metric("Total records", itsmString(client.report["total"]),
                               "square.stack", itsmAccent)
                        metric("Open work", itsmString(client.report["open"]),
                               "tray.full", .orange)
                        metric("Resolved", itsmString(client.report["resolved"]),
                               "checkmark.seal", .green)
                        metric("SLA breached",
                               itsmString(itsmDict(client.report["sla"])["breached"]),
                               "clock.badge.exclamationmark", .red)
                    }
                } else {
                    Label("Dashboard reporting is unavailable for this role. Records below still respect your permissions.",
                          systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(uiColor: .secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 15))
                }

                if !byType.isEmpty {
                    VStack(alignment: .leading, spacing: 11) {
                        Label("Records by type", systemImage: "chart.bar.fill")
                            .font(.headline)
                        Chart(byType) { point in
                            BarMark(x: .value("Type", point.label),
                                    y: .value("Records", point.value))
                                .foregroundStyle(itsmAccent)
                                .annotation(position: .top) {
                                    Text("\(point.value)").font(.caption2)
                                }
                        }
                        .frame(height: 160)
                    }
                    .itsmPanel()
                }

                if !trend.isEmpty {
                    VStack(alignment: .leading, spacing: 11) {
                        Label("Records created · last 30 days", systemImage: "chart.xyaxis.line")
                            .font(.headline)
                        Chart {
                            ForEach(Array(trend.enumerated()), id: \.offset) { item in
                                LineMark(x: .value("Day", item.element.0),
                                         y: .value("New records", item.element.1))
                                    .foregroundStyle(itsmAccent)
                                PointMark(x: .value("Day", item.element.0),
                                          y: .value("New records", item.element.1))
                                    .foregroundStyle(itsmAccent)
                            }
                        }
                        .frame(height: 145)
                        Text("Actual daily counts from Hi5Central reporting. Days with no reported records are omitted.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .itsmPanel()
                }

                if !byPriority.isEmpty {
                    VStack(alignment: .leading, spacing: 11) {
                        Label("Priority mix", systemImage: "exclamationmark.circle")
                            .font(.headline)
                        Chart(byPriority) { point in
                            BarMark(x: .value("Count", point.value),
                                    y: .value("Priority", point.label))
                                .foregroundStyle(itsmAccent)
                        }
                        .frame(height: CGFloat(max(100, byPriority.count * 37)))
                    }
                    .itsmPanel()
                }

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Recently updated").font(.title3.bold())
                        Spacer()
                        if let refreshed = client.lastRefreshed {
                            Text(refreshed, style: .time)
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if recent.isEmpty {
                        Label("No accessible records found.", systemImage: "tray")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(recent) { record in
                            Button { selected = record } label: {
                                ITSMRecordRow(record: record)
                            }
                            .buttonStyle(.plain)
                            if record.id != recent.last?.id { Divider() }
                        }
                    }
                }
                .itsmPanel()
            }
            .padding(.horizontal, 15)
            .padding(.top, 10)
            .padding(.bottom, 28)
        }
        .refreshable { await client.refreshAll() }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $selected) { record in
            ITSMRecordDetail(record: record)
                .environmentObject(client)
        }
    }

    private func metric(_ name: String, _ value: String, _ icon: String, _ colour: Color) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Image(systemName: icon).font(.title3).foregroundStyle(colour)
            Text(value).font(.system(.title2, design: .rounded, weight: .bold))
            Text(name).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 94, alignment: .leading)
        .padding(13)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 16))
    }
}

extension View {
    func itsmPanel() -> some View {
        padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 16))
    }
}
