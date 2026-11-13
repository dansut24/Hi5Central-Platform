import SwiftUI

/// Native record creation, no form web view. The API still validates the
/// technician's create/assignment permissions and tenant directory keys.
struct ITSMRecordComposer: View {
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    var onCreated: (ITSMRecord) -> Void = { _ in }

    @State private var type = "Incident"
    @State private var title = ""
    @State private var description = ""
    @State private var priority = "Medium"
    @State private var requesterId = ""
    @State private var searchPerson = ""
    @State private var team = ""
    @State private var assignee = ""
    @State private var service = ""
    @State private var category = ""
    @State private var submitting = false
    @State private var issue: String?

    private var people: [[String: Any]] {
        client.people.filter { row in
            !searchPerson.isEmpty
                && [itsmString(row["name"]), itsmString(row["email"])]
                    .joined(separator: " ")
                    .localizedCaseInsensitiveContains(searchPerson)
        }.prefix(7).map { $0 }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Record type") {
                    Picker("Type", selection: $type) {
                        ForEach(["Incident", "Problem", "Change"], id: \.self) { value in
                            Text(value)
                        }
                    }
                }
                Section("Description") {
                    TextField("Summary", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                    TextEditor(text: $description)
                        .frame(minHeight: 120)
                        .accessibilityLabel("Detailed description")
                }
                Section("Requester") {
                    TextField("Find a person", text: $searchPerson)
                        .textInputAutocapitalization(.words)
                    if !requesterId.isEmpty {
                        Label("Selected from company directory", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                        Button("Clear requester") { requesterId = ""; searchPerson = "" }
                    } else {
                        ForEach(Array(people.enumerated()), id: \.offset) { pair in
                            let person = pair.element
                            Button {
                                requesterId = itsmString(person["id"]).isEmpty
                                    ? itsmString(person["externalKey"])
                                    : itsmString(person["id"])
                                searchPerson = itsmString(person["name"])
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(itsmString(person["name"]))
                                    Text(itsmString(person["email"]))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                Section("Classification") {
                    Picker("Priority", selection: $priority) {
                        ForEach(["Low","Medium","High","Critical"], id: \.self) { Text($0) }
                    }
                    TextField("Service", text: $service)
                    TextField("Category", text: $category)
                }
                Section("Assignment") {
                    Picker("Assignment group", selection: $team) {
                        Text("Unassigned").tag("")
                        ForEach(Array(client.teams.enumerated()), id: \.offset) { pair in
                            let name = itsmString(pair.element["name"])
                            Text(name).tag(name)
                        }
                    }
                    Picker("Technician", selection: $assignee) {
                        Text("Unassigned").tag("")
                        ForEach(Array(client.people.filter {
                            !itsmString($0["userId"]).isEmpty
                        }.enumerated()), id: \.offset) { pair in
                            let name = itsmString(pair.element["name"])
                            Text(name).tag(name)
                        }
                    }
                }
                if let issue {
                    Section {
                        Label(issue, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("New \(type)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if submitting { ProgressView() } else { Text("Create").bold() }
                    }
                    .disabled(submitting || title.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
                }
            }
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        do {
            let record = try await client.createRecord(
                type: type, title: title, description: description,
                priority: priority, requesterId: requesterId,
                team: team, assignee: assignee, service: service, category: category
            )
            onCreated(record)
            dismiss()
        } catch {
            issue = error.localizedDescription
        }
    }
}

struct ITSMEditRecord: View {
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    let record: ITSMRecord
    var onUpdated: (ITSMRecord) -> Void = { _ in }

    @State private var title = ""
    @State private var description = ""
    @State private var service = ""
    @State private var category = ""
    @State private var saving = false
    @State private var issue: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Record summary") {
                    TextField("Title", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                }
                Section("Description") {
                    TextEditor(text: $description)
                        .frame(minHeight: 170)
                }
                Section("Classification") {
                    TextField("Service", text: $service)
                    TextField("Category", text: $category)
                }
                if let issue {
                    Text(issue).font(.footnote).foregroundStyle(.orange)
                }
            }
            .navigationTitle("Edit \(record.id)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save").bold() }
                    }
                    .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
                }
            }
            .onAppear {
                title = record.title
                description = record.description
                service = record.service
                category = record.category
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let updated = try await client.editDetails(record,
                title: title, description: description,
                service: service, category: category)
            onUpdated(updated)
            dismiss()
        } catch {
            issue = error.localizedDescription
        }
    }
}
