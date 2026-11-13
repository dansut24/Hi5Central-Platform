import SwiftUI

/// One native search surface spanning both subscribed products. Everything
/// comes from existing permission-filtered ITSM/RMM client state.
struct UnifiedGlobalSearch: View {
    @EnvironmentObject private var itsm: ITSMClient
    @EnvironmentObject private var rmm: RMMClient
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @EnvironmentObject private var rmmState: RMMState
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var scope = "All"
    @State private var selectedRecord: ITSMRecord?
    @State private var selectedDevice: ManagedDevice?
    @State private var selectedArticle: ITSMArticle?
    @State private var selectedTask: ITSMTask?
    @State private var selectedAsset: ITSMDictionaryItem?
    @State private var selectedPerson: ITSMDictionaryItem?
    @State private var selectedProject: ITSMDictionaryItem?

    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var includeITSM: Bool {
        auth.hasITSM && itsm.authenticated && scope != "RMM"
    }
    private var includeRMM: Bool {
        auth.hasRMM && rmm.authenticated && scope != "ITSM"
    }
    private func matches(_ fields: [String]) -> Bool {
        fields.joined(separator: " ").localizedCaseInsensitiveContains(needle)
    }

    private var records: [ITSMRecord] {
        guard includeITSM && !needle.isEmpty else { return [] }
        return Array(itsm.records.filter {
            matches([$0.id, $0.title, $0.type, $0.priority,
                     $0.status, $0.requester, $0.assignee, $0.service])
        }.prefix(40))
    }
    private var tasks: [ITSMTask] {
        guard includeITSM && !needle.isEmpty else { return [] }
        return Array(itsm.tasks.filter {
            matches([$0.title, $0.reference, $0.assignedTo, $0.status])
        }.prefix(25))
    }
    private var articles: [ITSMArticle] {
        guard includeITSM && !needle.isEmpty else { return [] }
        return Array(itsm.articles.filter {
            matches([$0.id, $0.title, $0.summary, $0.category])
        }.prefix(20))
    }
    private var devices: [ManagedDevice] {
        guard includeRMM && !needle.isEmpty else { return [] }
        return Array(rmm.devices.filter {
            matches([$0.name, $0.id, $0.agentId, $0.platform,
                     $0.site, $0.assignedTo, $0.status])
        }.prefix(40))
    }
    private func directory(_ rows: [[String: Any]], keys: [String]) -> [[String: Any]] {
        guard includeITSM && !needle.isEmpty else { return [] }
        return Array(rows.filter { row in
            matches(keys.map { itsmString(row[$0]) })
        }.prefix(20))
    }
    private var people: [[String: Any]] {
        directory(itsm.people, keys: ["name", "email", "team", "role"])
    }
    private var assets: [[String: Any]] {
        directory(itsm.cmdb, keys: ["name", "reference", "ciType", "serialNumber", "service"])
    }
    private var projects: [[String: Any]] {
        directory(itsm.projects, keys: ["name", "id", "owner", "status"])
    }
    private var hasResults: Bool {
        !records.isEmpty || !tasks.isEmpty || !articles.isEmpty
            || !devices.isEmpty || !people.isEmpty || !assets.isEmpty || !projects.isEmpty
    }

    var body: some View {
        NavigationStack {
            List {
                if auth.hasITSM && auth.hasRMM {
                    Section {
                        Picker("Search in", selection: $scope) {
                            Text("All").tag("All")
                            Text("ITSM").tag("ITSM")
                            Text("RMM").tag("RMM")
                        }
                        .pickerStyle(.segmented)
                    }
                }

                if !devices.isEmpty {
                    Section("Devices · \(devices.count)") {
                        ForEach(devices) { device in
                            Button {
                                selectedDevice = device
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "desktopcomputer")
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(device.name).font(.subheadline.weight(.medium))
                                            .foregroundStyle(.primary)
                                        Text([device.platform, device.site].filter { !$0.isEmpty }.joined(separator: " · "))
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Circle()
                                        .fill(device.isOnline ? Color.green : Color.orange)
                                        .frame(width: 8, height: 8)
                                }
                            }
                        }
                    }
                }

                if !records.isEmpty {
                    Section("ITSM records · \(records.count)") {
                        ForEach(records) { record in
                            Button { selectedRecord = record } label: {
                                ITSMRecordRow(record: record)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if !tasks.isEmpty {
                    Section("Tasks · \(tasks.count)") {
                        ForEach(tasks) { task in
                            Button { selectedTask = task } label: {
                                Label {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(task.title).font(.subheadline.weight(.medium))
                                            .foregroundStyle(.primary)
                                        Text(task.reference)
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                } icon: {
                                    Image(systemName: "checklist")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }

                if !assets.isEmpty {
                    Section("CMDB · \(assets.count)") {
                        ForEach(Array(assets.enumerated()), id: \.offset) { pair in
                            let item = pair.element
                            Button { selectedAsset = ITSMDictionaryItem(item) } label: {
                                Label(itsmString(item["name"]), systemImage: "server.rack")
                            }
                        }
                    }
                }
                if !people.isEmpty {
                    Section("People · \(people.count)") {
                        ForEach(Array(people.enumerated()), id: \.offset) { pair in
                            let person = pair.element
                            Button { selectedPerson = ITSMDictionaryItem(person) } label: {
                                Label {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(itsmString(person["name"]))
                                        Text(itsmString(person["email"]))
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                } icon: {
                                    Image(systemName: "person.crop.circle")
                                }
                            }
                        }
                    }
                }
                if !projects.isEmpty {
                    Section("Projects · \(projects.count)") {
                        ForEach(Array(projects.enumerated()), id: \.offset) { pair in
                            let project = pair.element
                            Button { selectedProject = ITSMDictionaryItem(project) } label: {
                                Label(itsmString(project["name"]), systemImage: "square.stack.3d.up")
                            }
                        }
                    }
                }
                if !articles.isEmpty {
                    Section("Knowledge · \(articles.count)") {
                        ForEach(articles) { article in
                            Button { selectedArticle = article } label: {
                                Label(article.title, systemImage: "books.vertical")
                            }
                        }
                    }
                }

                if needle.isEmpty {
                    Section {
                        Label("Search across your accessible tickets, devices, tasks, knowledge, people, assets and projects.",
                              systemImage: "magnifyingglass")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if !hasResults {
                    Section {
                        Label("No matches for “\(needle)”", systemImage: "magnifyingglass")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Search Hi5Central")
            .navigationTitle("Global search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $selectedRecord) { record in
                ITSMRecordDetail(record: record).environmentObject(itsm)
            }
            .sheet(item: $selectedTask) { task in
                ITSMTaskDetail(task: task).environmentObject(itsm)
            }
            .sheet(item: $selectedDevice) { device in
                NativeDeviceDetail(device: device)
                    .environmentObject(rmm)
                    .environmentObject(rmmState)
            }
            .sheet(item: $selectedArticle) { article in
                ITSMKnowledgeDetail(article: article)
            }
            .sheet(item: $selectedAsset) { asset in
                ITSMMetadataDetail(title: itsmString(asset.value["name"]),
                                   item: asset.value,
                                   fields: [
                                    ("Reference", "reference"), ("Type", "ciType"),
                                    ("Status", "status"), ("Service", "service"),
                                    ("RMM device", "linkedDeviceId")
                                   ])
            }
            .sheet(item: $selectedPerson) { person in
                ITSMMetadataDetail(title: itsmString(person.value["name"]),
                                   item: person.value,
                                   fields: [
                                    ("Email", "email"), ("Phone", "phone"),
                                    ("Role", "role"), ("Team", "team")
                                   ])
            }
            .sheet(item: $selectedProject) { project in
                ITSMProjectDetail(project: project.value).environmentObject(itsm)
            }
        }
    }
}
