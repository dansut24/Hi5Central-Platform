import SwiftUI

/// These read the real multi-tenant ITSM endpoints. Permission failures are
/// shown as errors, not replaced with sample data or another tenant's state.
struct ITSMDirectoryView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var search = ""
    @State private var selected: ITSMDictionaryItem?

    private var results: [[String: Any]] {
        client.people.filter { item in
            search.isEmpty || ["name", "email", "role", "team", "location"].map {
                itsmString(item[$0])
            }.joined(separator: " ").localizedCaseInsensitiveContains(search)
        }
    }
    var body: some View {
        List {
            if let message = client.extraErrors["people"] {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
            Section("People · \(results.count)") {
                ForEach(Array(results.enumerated()), id: \.offset) { pair in
                    let item = pair.element
                    Button {
                        selected = ITSMDictionaryItem(item)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "person.crop.circle.fill")
                                .font(.title2)
                                .foregroundStyle(.tint)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(itsmString(item["name"]))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text([itsmString(item["role"]), itsmString(item["team"])]
                                    .filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(itsmString(item["email"]))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if results.isEmpty {
                    Text("No matching people or directory unavailable.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("People")
        .searchable(text: $search, prompt: "Name, email, team, location")
        .refreshable { await client.refreshOrganisation() }
        .sheet(item: $selected) { detail in
            ITSMMetadataDetail(title: itsmString(detail.value["name"]), item: detail.value,
                               fields: [
                                ("Email", "email"), ("Phone", "phone"), ("Role", "role"),
                                ("Team", "team"), ("Location", "location"),
                                ("Availability", "status"), ("Access", "accessProfile")
                               ])
        }
    }
}

struct ITSMCMDBView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var search = ""
    @State private var selected: ITSMDictionaryItem?
    private var results: [[String: Any]] {
        client.cmdb.filter { item in
            search.isEmpty || ["name", "reference", "ciType", "serialNumber", "service"]
                .map { itsmString(item[$0]) }.joined(separator: " ")
                .localizedCaseInsensitiveContains(search)
        }
    }
    var body: some View {
        List {
            if let message = client.extraErrors["cmdb"] {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
            Section("Configuration items · \(results.count)") {
                ForEach(Array(results.enumerated()), id: \.offset) { pair in
                    let ci = pair.element
                    Button { selected = ITSMDictionaryItem(ci) } label: {
                        HStack(spacing: 11) {
                            Image(systemName: "server.rack")
                                .foregroundStyle(.tint)
                                .frame(width: 29)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(itsmString(ci["name"]))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text("\(itsmString(ci["reference"])) · \(itsmString(ci["ciType"]))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(itsmString(ci["status"]))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if results.isEmpty {
                    Text("No matching configuration items.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("CMDB")
        .searchable(text: $search, prompt: "Search assets, serial numbers, service")
        .refreshable { await client.refreshCMDB() }
        .sheet(item: $selected) { detail in
            ITSMMetadataDetail(title: itsmString(detail.value["name"]), item: detail.value,
                               fields: [
                                ("Reference", "reference"), ("Type", "ciType"),
                                ("Status", "status"), ("Criticality", "criticality"),
                                ("Environment", "environment"), ("Service", "service"),
                                ("Owner", "ownerName"), ("Team", "ownerTeam"),
                                ("Site", "site"), ("Manufacturer", "manufacturer"),
                                ("Model", "model"), ("Serial", "serialNumber"),
                                ("IP address", "ipAddress"), ("RMM device", "linkedDeviceId"),
                                ("Description", "description")
                               ])
        }
    }
}

struct ITSMProjectsView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var search = ""
    @State private var selected: ITSMDictionaryItem?
    private var results: [[String: Any]] {
        client.projects.filter { item in
            search.isEmpty || ["name", "id", "status", "owner", "team", "priority"]
                .map { itsmString(item[$0]) }.joined(separator: " ")
                .localizedCaseInsensitiveContains(search)
        }
    }
    var body: some View {
        List {
            if let message = client.extraErrors["projects"] {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
            Section("Projects · \(results.count)") {
                ForEach(Array(results.enumerated()), id: \.offset) { pair in
                    let project = pair.element
                    Button { selected = ITSMDictionaryItem(project) } label: {
                        HStack(spacing: 11) {
                            Image(systemName: "square.stack.3d.up")
                                .foregroundStyle(.tint)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(itsmString(project["name"]))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text("\(itsmString(project["id"])) · \(itsmString(project["status"]))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text("Owner: \(itsmString(project["owner"]))")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(itsmString(project["health"]))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                if results.isEmpty { Text("No projects found.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Projects")
        .searchable(text: $search, prompt: "Project name or owner")
        .refreshable { await client.refreshProjects() }
        .sheet(item: $selected) { detail in
            ITSMProjectDetail(project: detail.value)
                .environmentObject(client)
        }
    }
}

struct ITSMCalendarView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var selectedDate = Date()
    private var dateKey: String {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        return df.string(from: selectedDate)
    }
    private var items: [[String: Any]] {
        client.calendar.filter { itsmString($0["date"]).hasPrefix(dateKey) }
            .sorted { itsmString($0["title"]) < itsmString($1["title"]) }
    }
    var body: some View {
        List {
            Section {
                DatePicker("Project calendar", selection: $selectedDate,
                           displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(.accentColor)
                    .labelsHidden()
            }
            if let message = client.extraErrors["calendar"] {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
            Section("Milestones and tasks · \(dateKey)") {
                ForEach(Array(items.enumerated()), id: \.offset) { pair in
                    let event = pair.element
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: itsmString(event["type"]).contains("milestone")
                              ? "flag.fill" : "calendar")
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(itsmString(event["title"])).font(.subheadline.weight(.medium))
                            Text([itsmString(event["projectId"]), itsmString(event["status"])]
                                .filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if items.isEmpty {
                    Text("No reported project events on this date.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Calendar")
        .refreshable { await client.refreshCalendar() }
    }
}

struct ITSMDictionaryItem: Identifiable {
    let id: String = UUID().uuidString
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

struct ITSMMetadataDetail: View {
    let title: String
    let item: [String: Any]
    let fields: [(String, String)]
    @Environment(\.dismiss) private var dismiss
    #if HI5CENTRAL_UNIFIED
    @Environment(\.openURL) private var openURL
    #endif

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(fields, id: \.1) { name, key in
                        let value = itsmString(item[key])
                        LabeledContent(name, value: value.isEmpty ? "—" : value)
                    }
                }
                #if HI5CENTRAL_UNIFIED
                if let id = item["linkedDeviceId"] as? String,
                   UUID(uuidString: id) != nil,
                   let url = URL(string: "hi5central://device/\(id)") {
                    Section("Remote Monitoring") {
                        Button {
                            dismiss()
                            openURL(url)
                        } label: {
                            Label("Open linked device in RMM", systemImage: "desktopcomputer")
                        }
                    }
                }
                #endif
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct ITSMProjectDetail: View {
    let project: [String: Any]
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    @State private var current: [String: Any] = [:]
    @State private var issue: String?

    private var data: [String: Any] { current.isEmpty ? project : current }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(itsmString(data["name"]))
                        .font(.title3.weight(.semibold))
                    Text(itsmString(data["summary"]).isEmpty
                         ? itsmString(data["description"]) : itsmString(data["summary"]))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    LabeledContent("Reference", value: itsmString(data["id"]))
                    LabeledContent("Status", value: itsmString(data["status"]))
                    LabeledContent("Health", value: itsmString(data["health"]))
                    LabeledContent("Owner", value: itsmString(data["owner"]))
                    LabeledContent("Target date", value: itsmString(data["targetDate"]))
                }
                Section("Tasks") {
                    ForEach(Array(itsmRows(data["tasks"]).enumerated()), id: \.offset) { pair in
                        let t = pair.element
                        VStack(alignment: .leading, spacing: 4) {
                            Text(itsmString(t["title"])).font(.subheadline.weight(.medium))
                            Text("\(itsmString(t["status"])) · \(itsmString(t["assignee"]))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Milestones") {
                    ForEach(Array(itsmRows(data["milestones"]).enumerated()), id: \.offset) { pair in
                        let m = pair.element
                        VStack(alignment: .leading, spacing: 4) {
                            Text(itsmString(m["title"])).font(.subheadline.weight(.medium))
                            Text("\(itsmString(m["status"])) · Due \(itsmString(m["dueDate"]))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Risks") {
                    ForEach(Array(itsmRows(data["risks"]).enumerated()), id: \.offset) { pair in
                        let risk = pair.element
                        VStack(alignment: .leading, spacing: 4) {
                            Text(itsmString(risk["title"])).font(.subheadline.weight(.medium))
                            Text("\(itsmString(risk["severity"])) · \(itsmString(risk["status"]))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let issue {
                    Text(issue).font(.footnote).foregroundStyle(.orange)
                }
            }
            .navigationTitle("Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                guard let id = data["id"] as? String else { return }
                do { current = try await client.projectDetail(id) }
                catch { issue = error.localizedDescription }
            }
        }
    }
}
