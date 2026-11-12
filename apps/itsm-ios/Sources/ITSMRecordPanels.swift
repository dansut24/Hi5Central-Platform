import SwiftUI

/// Separate panel composition keeps the Swift compiler efficient even as the
/// full-native record detail grows, and preserves dynamic type/safe areas.
struct ITSMRecordSupportingSections: View {
    let record: ITSMRecord
    @Binding var selectedApproval: ITSMPendingApproval?
    @Binding var selectedTask: ITSMTask?

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            if !record.sla.isEmpty { slaPanel }
            if record.isServiceRequest && !record.approvals.isEmpty { approvalsPanel }
            if !record.requestTasks.isEmpty { tasksPanel }
            if !record.attachments.isEmpty { attachmentsPanel }
        }
    }

    private var slaPanel: some View {
        VStack(alignment: .leading, spacing: 11) {
            Label("Service level", systemImage: "clock").font(.headline)
            let response = itsmDict(record.sla["response"])
            let resolution = itsmDict(record.sla["resolution"])
            if !response.isEmpty {
                row("Response", itsmString(response["state"]))
                row("Response deadline", itsmDate(itsmString(response["dueAt"])))
            }
            if !resolution.isEmpty {
                row("Resolution", itsmString(resolution["state"]))
                row("Resolution deadline", itsmDate(itsmString(resolution["dueAt"])))
            }
            if record.sla["paused"] as? Bool == true {
                Label("SLA paused", systemImage: "pause.circle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .itsmPanel()
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            Spacer()
            Text(value.isEmpty ? "—" : value)
                .font(.subheadline.weight(.medium))
                .multilineTextAlignment(.trailing)
        }
    }

    private var approvalsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Approvals", systemImage: "checkmark.shield").font(.headline)
            ForEach(Array(record.approvals.enumerated()), id: \.offset) { pair in
                let approval = pair.element
                Button {
                    selectedApproval = ITSMPendingApproval(record: record, raw: approval)
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: itsmString(approval["status"]) == "Approved"
                              ? "checkmark.circle.fill" : "clock")
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(itsmString(approval["label"]))
                                .font(.subheadline.weight(.medium))
                            Text(itsmString(approval["approver"]))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(itsmString(approval["status"]))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .itsmPanel()
    }

    private var tasksPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Request tasks", systemImage: "checklist").font(.headline)
            ForEach(Array(record.requestTasks.enumerated()), id: \.offset) { pair in
                let task = pair.element
                Button {
                    selectedTask = ITSMTask(task)
                } label: {
                    HStack {
                        Text(itsmString(task["title"]))
                            .font(.subheadline.weight(.medium))
                        Spacer()
                        Text(itsmString(task["status"]))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .itsmPanel()
    }

    private var attachmentsPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Attachments", systemImage: "paperclip").font(.headline)
            ForEach(Array(record.attachments.enumerated()), id: \.offset) { pair in
                let file = pair.element
                HStack {
                    Image(systemName: "doc").foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(itsmString(file["fileName"]).isEmpty
                             ? itsmString(file["file_name"]) : itsmString(file["fileName"]))
                            .font(.subheadline)
                        Text(itsmDate(itsmString(file["createdAt"])))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Text("File transfers require verified attachment endpoints and are not available in this release.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .itsmPanel()
    }
}

struct ITSMRecordActions: View {
    @EnvironmentObject private var client: ITSMClient
    let busy: Bool
    let onPriority: (String) -> Void
    let onStatus: (String) -> Void
    let onTeam: (String) -> Void
    let onAssignee: (String) -> Void

    private var technicians: [[String: Any]] {
        client.people.filter {
            ($0["active"] as? Bool) != false
            && !itsmString($0["userId"]).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Quick actions", systemImage: "slider.horizontal.3")
                .font(.headline)
            HStack(spacing: 8) {
                Menu {
                    ForEach(["Low", "Medium", "High", "Critical"], id: \.self) { value in
                        Button(value) { onPriority(value) }
                    }
                } label: {
                    Label("Priority", systemImage: "flag")
                }
                Menu {
                    ForEach(["New", "In Progress", "Pending"], id: \.self) { value in
                        Button(value) { onStatus(value) }
                    }
                } label: {
                    Label("Work state", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .buttonStyle(.bordered)
            HStack(spacing: 8) {
                Menu {
                    ForEach(Array(client.teams.filter {
                        ($0["active"] as? Bool) != false
                    }.enumerated()), id: \.offset) { pair in
                        let name = itsmString(pair.element["name"])
                        Button(name) { onTeam(name) }
                    }
                } label: {
                    Label("Team", systemImage: "person.2")
                }
                Menu {
                    Button("Unassigned") { onAssignee("Unassigned") }
                    ForEach(Array(technicians.enumerated()), id: \.offset) { pair in
                        let name = itsmString(pair.element["name"])
                        Button(name) { onAssignee(name) }
                    }
                } label: {
                    Label("Assign", systemImage: "person.crop.circle")
                }
            }
            .buttonStyle(.bordered)
            .disabled(busy)
            Text("Resolution uses a separate versioned lifecycle workflow; unavailable until its API is confirmed.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .itsmPanel()
    }
}
