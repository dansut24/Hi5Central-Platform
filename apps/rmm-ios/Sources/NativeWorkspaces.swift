import SwiftUI

private let workBlue = Color(red: 0.18, green: 0.48, blue: 0.96)

func nativeString(_ value: Any?) -> String {
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return ""
}

func nativeText(_ row: [String: Any], _ keys: [String], fallback: String = "Not reported") -> String {
    for key in keys {
        let value = nativeString(row[key])
        if !value.isEmpty { return value }
    }
    return fallback
}

func nativeRows(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }
func nativeDict(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }

struct NativePanel<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label(title, systemImage: symbol).font(.headline).foregroundStyle(.primary)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 17))
    }
}

struct NativeMetric: View {
    let title: String
    let value: String
    let symbol: String
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Image(systemName: symbol).font(.title3).foregroundStyle(workBlue)
            Text(value).font(.system(size: 28, weight: .bold, design: .rounded))
            Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(15)
        .frame(maxWidth: .infinity, minHeight: 121, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}

struct NativeIssue: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.footnote).foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct NativePatching: View {
    @EnvironmentObject private var client: RMMClient
    @State private var bundle: [String: Any] = [:]
    @State private var loading = false
    @State private var failure: String?
    @State private var section = 0
    private let sections = ["Summary", "Policies", "Updates", "Security"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Patching").font(.title2.bold())
                Text("Software updates, policies and vulnerability exposure")
                    .font(.subheadline).foregroundStyle(.secondary)
                if loading && bundle.isEmpty { ProgressView("Loading patch data…") }
                if let failure { NativeIssue(message: failure) }
                Picker("Patching", selection: $section) {
                    ForEach(0..<sections.count, id: \.self) { i in
                        Text(sections[i]).tag(i)
                    }
                }
                .pickerStyle(.segmented)
                switch section {
                case 0: overview
                case 1: policies
                case 2: updates
                default: vulnerabilities
                }
            }
            .padding(16)
        }
        .refreshable { await reload() }
        .task { if bundle.isEmpty { await reload() } }
    }

    private var overview: some View {
        let summary = nativeDict(bundle["overview"])
        return VStack(spacing: 14) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 11) {
                NativeMetric(title: "Agent devices", value: nativeText(summary, ["agentDevices"], fallback: "—"),
                             symbol: "desktopcomputer")
                NativeMetric(title: "Available updates", value: nativeText(summary, ["updateAvailable"], fallback: "—"),
                             symbol: "arrow.down.circle")
                NativeMetric(title: "Software installed", value: nativeText(summary, ["softwareInstallations"], fallback: "—"),
                             symbol: "square.stack.3d.up")
                NativeMetric(title: "Qualified catalogue", value: nativeText(summary, ["qualifiedCatalogue"], fallback: "—"),
                             symbol: "checkmark.shield")
            }
            NativePanel(title: "Patch deployment", symbol: "checkmark.shield") {
                Text("Review installed software, patch policies and vulnerability exposure before deploying updates.")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack {
                    Text("Active policies").font(.subheadline)
                    Spacer()
                    Text("\(nativeRows(bundle["policies"]).count)").font(.headline)
                }
                HStack {
                    Text("Recent deployments").font(.subheadline)
                    Spacer()
                    Text("\(nativeRows(bundle["deployments"]).count)").font(.headline)
                }
            }
        }
    }

    private var policies: some View {
        let rows = nativeRows(bundle["policies"])
        return VStack(spacing: 11) {
            if rows.isEmpty { emptyState("No patch policies", "There are no policies available for your current permissions.", "shield") }
            ForEach(rows.indices, id: \.self) { index in
                let row = rows[index]
                NativePanel(title: nativeText(row, ["name", "title"], fallback: "Patch policy"),
                            symbol: "shield.lefthalf.filled") {
                    HStack {
                        Text(nativeText(row, ["platform", "policy_type", "category"], fallback: "General"))
                        Spacer()
                        Text(nativeText(row, ["enabled", "status"], fallback: "Configured"))
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    if !nativeString(row["description"]).isEmpty {
                        Text(nativeString(row["description"]))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            Text("Native policy editing and deployment confirmation are being migrated separately to preserve existing approval and safety checks.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var updates: some View {
        let data = nativeDict(bundle["windowsUpdates"])
        let schedules = nativeRows(bundle["unixOsSchedules"])
        let deployments = nativeRows(bundle["deployments"])
        return VStack(spacing: 12) {
            NativePanel(title: "Windows update management", symbol: "square.grid.2x2") {
                if data.isEmpty {
                    Text("No Windows update summary available.")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(data.keys.sorted().prefix(8)), id: \.self) { key in
                        let value = data[key]
                        if let number = value as? NSNumber {
                            HStack {
                                Text(key.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.subheadline)
                                Spacer()
                                Text(number.stringValue).font(.subheadline.bold())
                            }
                        } else if let array = value as? [Any] {
                            HStack {
                                Text(key.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.subheadline)
                                Spacer()
                                Text("\(array.count)").font(.subheadline.bold())
                            }
                        }
                    }
                }
            }
            NativePanel(title: "Update activity", symbol: "arrow.triangle.2.circlepath") {
                Text("\(deployments.count) patch deployment records")
                    .font(.subheadline)
                Text("\(schedules.count) Linux/macOS update schedules")
                    .font(.subheadline)
            }
        }
    }

    private var vulnerabilities: some View {
        let exposures = nativeDict(bundle["vulnerabilityExposures"])
        let rows = nativeRows(bundle["vulnerabilityExposureRows"])
        return VStack(spacing: 11) {
            NativePanel(title: "Vulnerability exposure", symbol: "exclamationmark.shield") {
                if exposures.isEmpty {
                    Text("Exposure summary not available.")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(exposures.keys.sorted().prefix(8)), id: \.self) { key in
                        HStack {
                            Text(key.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(.subheadline)
                            Spacer()
                            Text(nativeString(exposures[key])).font(.subheadline.weight(.medium))
                                .lineLimit(1)
                        }
                    }
                }
            }
            ForEach(rows.prefix(20).indices, id: \.self) { index in
                let row = rows[index]
                NativePanel(title: nativeText(row, ["application_name", "name", "cve_id", "cveId"], fallback: "Security finding"),
                            symbol: "exclamationmark.triangle") {
                    Text(nativeText(row, ["severity", "risk", "status"], fallback: "Review required"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            bundle = try await client.nativeRead(.patching)
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

struct NativeSoftware: View {
    @EnvironmentObject private var client: RMMClient
    @State private var source = "hi5central"
    @State private var query = ""
    @State private var page = 1
    @State private var results: [String: Any] = [:]
    @State private var busy = false
    @State private var failure: String?
    @State private var selected: CatalogueItem?

    private var items: [[String: Any]] { nativeRows(results["items"]) }
    private var pages: Int { (results["pages"] as? NSNumber)?.intValue ?? 1 }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    Text("Software catalogue").font(.title2.bold())
                    Text("Search approved packages and the WinGet repository")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Picker("Catalogue source", selection: $source) {
                        Text("Hi5Central").tag("hi5central")
                        Text("WinGet").tag("winget")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: source) { _ in page = 1 }
                    TextField("Search applications or publishers", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(13)
                        .background(Color(uiColor: .secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 11))
                        .onChange(of: query) { _ in page = 1 }
                    if busy { ProgressView().frame(maxWidth: .infinity) }
                    if let failure { NativeIssue(message: failure) }
                    HStack {
                        Text("\(nativeText(results, ["total"], fallback: "0")) matching packages")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text("Page \(page) / \(max(1,pages))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if items.isEmpty && !busy {
                        emptyState("No packages found", "Try a different search or source.", "shippingbox")
                    }
                    LazyVStack(spacing: 10) {
                        ForEach(items.indices, id: \.self) { i in
                            let item = items[i]
                            Button {
                                selected = CatalogueItem(index: i, data: item)
                            } label: {
                                HStack(spacing: 13) {
                                    Image(systemName: "shippingbox")
                                        .font(.title3).foregroundStyle(workBlue)
                                        .frame(width: 36)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(nativeText(item, ["name", "displayName"], fallback: "Application"))
                                            .font(.subheadline.bold()).foregroundStyle(.primary)
                                            .multilineTextAlignment(.leading)
                                        Text(nativeText(item, ["publisher", "provider", "source"], fallback: "Unknown publisher"))
                                            .font(.caption).foregroundStyle(.secondary)
                                        Text(nativeText(item, ["latestVersion", "version", "packageId"], fallback: ""))
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 4)
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                                .padding(14)
                                .background(Color(uiColor: .secondarySystemBackground),
                                            in: RoundedRectangle(cornerRadius: 15))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    HStack {
                        Button("Previous") { page = max(1, page - 1) }
                            .disabled(page <= 1)
                        Spacer()
                        Button("Next") { page = min(max(1, pages), page + 1) }
                            .disabled(page >= pages)
                    }
                    .buttonStyle(.bordered)
                }
                .padding(16)
            }
            .refreshable { await reload() }
        }
        .task(id: source + ":" + query + ":" + String(page)) {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await reload()
        }
        .sheet(item: $selected) { item in
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Image(systemName: "shippingbox.fill")
                            .font(.system(size: 35)).foregroundStyle(workBlue)
                        Text(nativeText(item.data, ["name"], fallback: "Application"))
                            .font(.title2.bold())
                        ForEach(["publisher", "source", "packageId", "version", "provider", "qualificationState"], id: \.self) { key in
                            HStack(alignment: .top) {
                                Text(key).font(.subheadline).foregroundStyle(.secondary)
                                Spacer()
                                Text(nativeText(item.data, [key])).font(.subheadline.weight(.medium))
                                    .multilineTextAlignment(.trailing)
                            }
                            Divider()
                        }
                        Text("Software installation and bulk deployment are not enabled in this native preview. Existing catalogue safety, admission and patch workflow checks will be preserved.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(20)
                }
                .navigationTitle("Package details")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { selected = nil }
                    }
                }
            }
        }
    }

    private func reload() async {
        busy = true
        defer { busy = false }
        do {
            results = try await client.nativeRead(.catalogue(query: query, source: source, page: page))
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

private struct CatalogueItem: Identifiable {
    let index: Int
    let data: [String: Any]
    var id: Int { index }
}
