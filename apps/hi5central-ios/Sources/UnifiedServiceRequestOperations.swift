import SwiftUI
import UniformTypeIdentifiers

/// Native Service Request fulfilment uses the existing server transition graph.
struct UnifiedServiceRequestWorkflowPanel: View {
    @EnvironmentObject private var client: ITSMClient
    let record: ITSMRecord
    let onUpdated: (ITSMRecord) -> Void

    @State private var proposedStatus = ""
    @State private var outcome = ""
    @State private var showConfirmation = false
    @State private var busy = false
    @State private var issue: String?

    private var nextStatuses: [String] {
        switch record.status {
        case "New", "Approved": return ["In Progress"]
        case "In Progress": return ["Completed"]
        case "Completed": return ["Closed", "In Progress"]
        default: return []
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Service Request fulfilment", systemImage: "shippingbox")
                .font(.headline)
            Text(record.status == "Pending Approval"
                 ? "This request is awaiting its assigned approvals."
                 : "Progress this request using the server-managed fulfilment workflow.")
                .font(.caption).foregroundStyle(.secondary)

            if !nextStatuses.isEmpty {
                ForEach(nextStatuses, id: \.self) { status in
                    Button {
                        proposedStatus = status
                        outcome = ""
                        showConfirmation = true
                    } label: {
                        Label(status == "In Progress" && record.status == "Completed"
                              ? "Reopen fulfilment" :
                              status == "In Progress" ? "Start fulfilment" :
                              status == "Completed" ? "Complete request" : "Close request",
                              systemImage: "arrow.right.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                }
            } else {
                Text("No direct fulfilment transition is currently available.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Menu {
                ForEach(["Low", "Medium", "High", "Critical"], id: \.self) { value in
                    Button("Priority: \(value)") { Task { await update(priority: value) } }
                }
            } label: {
                Label("Change priority", systemImage: "flag")
            }
            .disabled(busy)

            if !client.teams.isEmpty {
                Menu {
                    Button("Unassigned team") { Task { await update(team: "") } }
                    ForEach(Array(client.teams.enumerated()), id: \.offset) { item in
                        let name = itsmString(item.element["name"])
                        if !name.isEmpty && (item.element["active"] as? Bool) != false {
                            Button(name) { Task { await update(team: name) } }
                        }
                    }
                } label: {
                    Label("Change fulfilment team", systemImage: "person.2")
                }
                .disabled(busy)
            }
            if !client.people.isEmpty {
                Menu {
                    Button("Unassigned technician") { Task { await update(assignee: "") } }
                    ForEach(Array(client.people.enumerated()), id: \.offset) { item in
                        let name = itsmString(item.element["name"])
                        let id = itsmString(item.element["externalKey"])
                        if !name.isEmpty && !id.isEmpty &&
                           (item.element["active"] as? Bool) != false {
                            Button(name) { Task { await update(assignee: id) } }
                        }
                    }
                } label: {
                    Label("Assign technician", systemImage: "person.crop.circle")
                }
                .disabled(busy)
            }
            if busy { ProgressView("Updating Service Request…") }
            if let issue {
                Label(issue, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .itsmPanel()
        .sheet(isPresented: $showConfirmation) {
            NavigationStack {
                Form {
                    Text("Change \(record.id) from \(record.status) to \(proposedStatus)?")
                        .font(.headline)
                    if proposedStatus == "Completed" ||
                       (record.status == "Completed" && proposedStatus == "In Progress") {
                        Section("Required notes") {
                            TextEditor(text: $outcome).frame(minHeight: 105)
                        }
                    } else {
                        Text("Approvals, outstanding tasks and permitted transitions are validated by Hi5Central.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("Confirm transition")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showConfirmation = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Confirm") {
                            showConfirmation = false
                            Task { await transition() }
                        }
                        .disabled((proposedStatus == "Completed" ||
                                  (record.status == "Completed" && proposedStatus == "In Progress")) &&
                                  outcome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func transition() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        var values: [String: Any] = [:]
        if proposedStatus == "Completed" { values["completionNotes"] = outcome }
        if record.status == "Completed" && proposedStatus == "In Progress" {
            values["reopenReason"] = outcome
        }
        do {
            onUpdated(try await client.transitionServiceRequest(
                record, to: proposedStatus, values: values))
            issue = nil
        } catch { issue = error.localizedDescription }
    }

    private func update(priority: String? = nil, team: String? = nil,
                        assignee: String? = nil) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            onUpdated(try await client.updateServiceRequest(
                record, priority: priority, team: team, assignee: assignee))
            issue = nil
        } catch { issue = error.localizedDescription }
    }
}

struct UnifiedServiceRequestTasksPanel: View {
    @EnvironmentObject private var client: ITSMClient
    let record: ITSMRecord
    let onUpdated: (ITSMRecord) -> Void

    @State private var selectedTask: String?
    @State private var notes = ""
    @State private var busy = false
    @State private var issue: String?
    @State private var showingCompletion = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Fulfilment tasks", systemImage: "checklist").font(.headline)
            ForEach(Array(record.requestTasks.enumerated()), id: \.offset) { pair in
                let task = pair.element
                let key = itsmString(task["id"])
                let status = itsmString(task["status"])
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(itsmString(task["title"]))
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(status).font(.caption).foregroundStyle(.secondary)
                    }
                    let instructions = itsmString(task["instructions"])
                    if !instructions.isEmpty {
                        Text(instructions).font(.caption).foregroundStyle(.secondary)
                    }
                    if !key.isEmpty && !["Waiting", "Completed"].contains(status) {
                        HStack {
                            if status != "In Progress" {
                                Button("Start") { Task { await updateTask(key, "In Progress") } }
                                    .buttonStyle(.bordered)
                            }
                            Button("Complete") {
                                selectedTask = key
                                notes = ""
                                showingCompletion = true
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .disabled(busy)
                    }
                }
                .padding(.vertical, 5)
                Divider()
            }
            if busy { ProgressView("Updating task…") }
            if let issue {
                Text(issue).font(.caption).foregroundStyle(.orange)
            }
        }
        .itsmPanel()
        .sheet(isPresented: $showingCompletion) {
            NavigationStack {
                Form {
                    Section("Completion notes") {
                        TextEditor(text: $notes).frame(minHeight: 110)
                    }
                }
                .navigationTitle("Complete task")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showingCompletion = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Complete") {
                            let key = selectedTask
                            showingCompletion = false
                            if let key { Task { await updateTask(key, "Completed", note: notes) } }
                        }
                        .disabled(notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func updateTask(_ key: String, _ status: String, note: String = "") async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            onUpdated(try await client.updateServiceRequestTask(
                record, taskKey: key, status: status, completionNotes: note))
            issue = nil
        } catch { issue = error.localizedDescription }
    }
}

struct UnifiedServiceRequestAttachmentsPanel: View {
    @EnvironmentObject private var client: ITSMClient
    let record: ITSMRecord
    let onUpdated: (ITSMRecord) -> Void

    @State private var adding = false
    @State private var customer = false
    @State private var busy = false
    @State private var issue: String?
    @State private var sharedFile: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Attachments", systemImage: "paperclip").font(.headline)
            Picker("File visibility", selection: $customer) {
                Text("Internal").tag(false)
                Text("Customer").tag(true)
            }
            .pickerStyle(.segmented)
            ForEach(Array(record.attachments.enumerated()), id: \.offset) { pair in
                let attachment = pair.element
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(itsmString(attachment["fileName"]))
                            .font(.subheadline.weight(.medium))
                        Text(itsmString(attachment["visibility"]) == "internal" ?
                             "Internal" : "Customer")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        Task { await download(attachment) }
                    } label: {
                        Image(systemName: "square.and.arrow.down")
                    }
                    .disabled(busy)
                    .accessibilityLabel("Download attachment")
                }
                Divider()
            }
            if record.attachments.isEmpty {
                Text("No attachments yet.").font(.caption).foregroundStyle(.secondary)
            }
            Button {
                adding = true
            } label: {
                Label("Attach a file", systemImage: "plus.circle")
            }
            .buttonStyle(.bordered)
            .disabled(busy)
            if let sharedFile {
                ShareLink(item: sharedFile) {
                    Label("Share downloaded file", systemImage: "square.and.arrow.up")
                }
            }
            if busy { ProgressView("Transferring file…") }
            if let issue {
                Text(issue).font(.caption).foregroundStyle(.orange)
            }
            Text("Uploads are limited to 6 MB in this app and may be further restricted by your tenant's attachment policy.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .itsmPanel()
        .fileImporter(isPresented: $adding, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url):
                Task { await upload(url) }
            case .failure(let error):
                issue = error.localizedDescription
            }
        }
    }

    private func upload(_ url: URL) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            onUpdated(try await client.uploadServiceRequestAttachment(
                record, fileURL: url, customer: customer))
            issue = nil
        } catch { issue = error.localizedDescription }
    }

    private func download(_ attachment: [String: Any]) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            sharedFile = try await client.downloadServiceRequestAttachment(
                record, attachment: attachment)
            issue = nil
        } catch { issue = error.localizedDescription }
    }
}
