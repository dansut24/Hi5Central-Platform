import SwiftUI
import Charts

/// Charts use live inventory and telemetry already returned by the authorised
/// tenant RMM API. No made-up historical series or values for silent devices.
struct NativeFleetCharts: View {
    @EnvironmentObject private var client: RMMClient

    private struct SeriesPoint: Identifiable {
        let label: String
        let value: Int
        var id: String { label }
    }

    private var status: [SeriesPoint] {
        [
            SeriesPoint(label: "Online", value: client.onlineCount),
            SeriesPoint(label: "Offline", value: client.offlineDevices.count),
            SeriesPoint(label: "Inventory only", value: max(0, client.devices.count - client.installedCount))
        ]
    }

    private func mean(_ key: KeyPath<ManagedDevice, Int?>) -> Double? {
        let values = client.devices.filter(\.isOnline).compactMap { $0[keyPath: key] }
        guard !values.isEmpty else { return nil }
        return Double(values.reduce(0, +)) / Double(values.count)
    }

    private struct ResourcePoint: Identifiable {
        let name: String
        let usage: Double
        var id: String { name }
    }

    private var resources: [ResourcePoint] {
        [("CPU", mean(\.cpu)), ("Memory", mean(\.memory)), ("Disk", mean(\.disk))]
            .compactMap { name, usage in usage.map { ResourcePoint(name: name, usage: $0) } }
    }

    private var osMix: [SeriesPoint] {
        var counts: [String: Int] = [:]
        for device in client.devices where device.hasAgent {
            let name = device.platform.lowercased()
            let platform = name.contains("windows") ? "Windows"
                : (name.contains("mac") || name.contains("darwin") ? "macOS"
                : name.contains("linux") ? "Linux" : "Other")
            counts[platform, default: 0] += 1
        }
        return counts.map { SeriesPoint(label: $0.key, value: $0.value) }
            .sorted { $0.value > $1.value }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Fleet health", systemImage: "chart.bar.fill")
                .font(.title3.weight(.semibold))

            VStack(alignment: .leading, spacing: 10) {
                Text("Device availability")
                    .font(.subheadline.weight(.semibold))
                if client.devices.isEmpty {
                    Label("Connect devices to see live estate charts.", systemImage: "chart.bar")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 125)
                } else {
                    Chart(status) { item in
                        BarMark(
                            x: .value("Devices", item.value),
                            y: .value("Fleet", "Devices"),
                            stacking: .standard
                        )
                        .foregroundStyle(by: .value("State", item.label))
                    }
                    .chartXScale(domain: 0...max(1, client.devices.count))
                    .chartLegend(position: .bottom)
                    .frame(height: 105)
                    HStack {
                        ForEach(status) { item in
                            Text("\(item.label): \(item.value)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
            .nativeChartPanel()

            VStack(alignment: .leading, spacing: 10) {
                Text("Average resource usage")
                    .font(.subheadline.weight(.semibold))
                if resources.isEmpty {
                    Text("Waiting for CPU, memory and disk telemetry from online devices.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 90, alignment: .leading)
                } else {
                    Chart {
                        ForEach(resources) { metric in
                            BarMark(x: .value("Resource", metric.name),
                                    y: .value("Usage", metric.usage))
                                .foregroundStyle(Color.accentColor)
                                .annotation(position: .top) {
                                    Text("\(metric.usage, specifier: "%.0f")%")
                                        .font(.caption2)
                                }
                        }
                    }
                    .chartYScale(domain: 0...100)
                    .chartYAxis {
                        AxisMarks(values: [0,25,50,75,100])
                    }
                    .frame(height: 155)
                    Text("Average of reporting online agents only.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .nativeChartPanel()

            if !osMix.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Operating systems")
                        .font(.subheadline.weight(.semibold))
                    Chart(osMix) { item in
                        BarMark(x: .value("Devices", item.value),
                                y: .value("Operating system", item.label))
                            .foregroundStyle(Color.accentColor)
                            .annotation(position: .trailing) { Text("\(item.value)").font(.caption2) }
                    }
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4))
                    }
                    .frame(height: CGFloat(max(110, osMix.count * 39)))
                }
                .nativeChartPanel()
            }
        }
    }
}

private extension View {
    func nativeChartPanel() -> some View {
        self.padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 17))
    }
}
