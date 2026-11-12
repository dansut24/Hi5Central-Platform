import SwiftUI

struct ITSMPendingApproval: Identifiable {
    let record: ITSMRecord
    let raw: [String: Any]
    var id: String { itsmString(raw["id"]) }
    var title: String { itsmString(raw["label"]).isEmpty ? record.title : itsmString(raw["label"]) }
    var approver: String { itsmString(raw["approver"]) }
    var status: String { itsmString(raw["status"]) }
}

struct ITSMApprovalsView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var selected: ITSMPendingApproval?

    private var pending: [ITSMPendingApproval] {
        client.records
            .filter(\.isServiceRequest)
            .flatMap { record in
                record.approvals.filter { itsmString($0["status"]) == "Pending" }
                    .map { ITSMPendingApproval(record: record, raw: $0) }
            }
    }

    var body: some View {
        List {
            Section("\(pending.count) pending approvals") {
                ForEach(pending) { approval in
                    Button {
                        selected = approval
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark.shield")
                                .font(.title3)
                                .foregroundStyle(.tint)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(approval.record.id)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.tint)
                                Text(approval.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text("Approver: " + approval.approver)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                if pending.isEmpty {
                    Label("No pending approvals for accessible requests.",
                          systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Text("Decisions are authorised by the Hi5Central server. Only the assigned approver or an eligible administrator can approve or reject.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Approvals")
        .refreshable { await client.refreshRecords() }
        .sheet(item: $selected) { approval in
            ITSMApprovalDetail(approval: approval)
                .environmentObject(client)
        }
    }
}

struct ITSMApprovalDetail: View {
    let approval: ITSMPendingApproval
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var busy = false
    @State private var issue: String?
    @State private var requestedDecision: Bool?
    @State private var finished = false

    private var eligible: Bool {
        client.isAdmin
            || itsmString(approval.raw["approverUserId"]) == client.currentUserId
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Service request") {
                    LabeledContent("Reference", value: approval.record.id)
                    Text(approval.record.title)
                        .font(.headline)
                    LabeledContent("Requester", value: approval.record.requester)
                    LabeledContent("Priority", value: approval.record.priority)
                }
                Section("Approval") {
                    LabeledContent("Stage", value: approval.title)
                    LabeledContent("Approver", value: approval.approver)
                    LabeledContent("Status", value: approval.status)
                    if !eligible {
                        Text("This approval is not assigned to your current user account. If you are authorised through a linked person record, the server will verify that eligibility.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Decision note") {
                    TextEditor(text: $note)
                        .frame(minHeight: 110)
                    Text("A reason is required when rejecting.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    HStack(spacing: 14) {
                        Button {
                            requestedDecision = true
                        } label: {
                            Label("Approve", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || finished)
                        Button(role: .destructive) {
                            requestedDecision = false
                        } label: {
                            Label("Reject", systemImage: "xmark.circle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(busy || finished || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if busy { ProgressView("Recording decision…") }
                if let issue {
                    Label(issue, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
            .navigationTitle("Approval")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                requestedDecision == true ? "Approve this service request?" : "Reject this service request?",
                isPresented: Binding(get: { requestedDecision != nil },
                                     set: { if !$0 { requestedDecision = nil } }),
                titleVisibility: .visible) {
                    Button(requestedDecision == true ? "Confirm approval" : "Confirm rejection",
                           role: requestedDecision == false ? .destructive : nil) {
                        guard let accepted = requestedDecision else { return }
                        requestedDecision = nil
                        Task { await decide(accepted) }
                    }
                    Button("Cancel", role: .cancel) { requestedDecision = nil }
                }
        }
    }

    private func decide(_ accepted: Bool) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await client.decision(for: approval.record,
                                          approvalId: approval.id,
                                          accepted: accepted, note: note)
            finished = true
            dismiss()
        } catch {
            issue = error.localizedDescription
        }
    }
}

struct ITSMTaskDetail: View {
    let task: ITSMTask
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    @State private var data: [String: Any] = [:]
    @State private var note = ""
    @State private var completion = ""
    @State private var visibility = "Internal"
    @State private var busy = false
    @State private var issue: String?
    @State private var confirmation: String?

    private var currentStatus: String {
        itsmString(data["status"]).isEmpty ? task.status : itsmString(data["status"])
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(itsmString(data["title"]).isEmpty ? task.title : itsmString(data["title"]))
                        .font(.headline)
                    LabeledContent("Status", value: currentStatus)
                    LabeledContent("Assigned to",
                                   value: itsmString(data["assignee"]).isEmpty
                                   ? task.assignedTo : itsmString(data["assignee"]))
                    LabeledContent("Request",
                                   value: itsmString(itsmDict(data["primaryRequest"])["id"]))
                    LabeledContent("Due",
                                   value: itsmDate(itsmString(data["dueAt"])))
                }
                if !itsmString(data["instructions"]).isEmpty {
                    Section("Instructions") {
                        Text(itsmString(data["instructions"])).textSelection(.enabled)
                    }
                }
                Section("Progress") {
                    Picker("Update task status", selection: Binding(
                        get: { confirmation ?? currentStatus },
                        set: { confirmation = $0 })) {
                        ForEach(["Ready", "In Progress", "Blocked", "Completed"],
                                id: \.self) { Text($0) }
                    }
                    .disabled(busy)
                    if confirmation == "Completed" {
                        TextField("Completion notes", text: $completion, axis: .vertical)
                            .lineLimit(2...5)
                    }
                    Button("Apply status change") {
                        Task { await updateStatus() }
                    }
                    .disabled(busy || confirmation == nil || confirmation == currentStatus)
                }
                Section("Add task note") {
                    Picker("Visibility", selection: $visibility) {
                        Text("Internal").tag("Internal")
                        Text("Customer").tag("Customer")
                    }
                    .pickerStyle(.segmented)
                    TextEditor(text: $note)
                        .frame(minHeight: 90)
                    Button("Save note") {
                        Task { await saveNote() }
                    }
                    .disabled(busy || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if busy { ProgressView("Updating task…") }
                if let issue { Text(issue).font(.footnote).foregroundStyle(.orange) }
            }
            .navigationTitle("Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            data = try await client.taskDetail(task.id)
            issue = nil
        } catch { issue = error.localizedDescription }
    }

    private func updateStatus() async {
        guard let value = confirmation, value != currentStatus else { return }
        busy = true
        defer { busy = false }
        do {
            try await client.taskStatus(task.id, status: value, completionNotes: completion)
            confirmation = nil
            await load()
        } catch { issue = error.localizedDescription }
    }

    private func saveNote() async {
        busy = true
        defer { busy = false }
        do {
            try await client.taskNote(task.id, text: note, customer: visibility == "Customer")
            note = ""
            issue = nil
            await load()
        } catch { issue = error.localizedDescription }
    }
}
