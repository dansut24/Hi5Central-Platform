import SwiftUI

struct ITSMRecordRow: View {
    let record: ITSMRecord

    private var priorityColor: Color {
        switch record.priority.lowercased() {
        case "critical": return .red
        case "high": return .orange
        case "medium": return .blue
        default: return .secondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 3)
                .fill(priorityColor)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(record.id)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.tint)
                    Spacer(minLength: 8)
                    Text(record.priority.isEmpty ? "—" : record.priority)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(priorityColor)
                }
                Text(record.title.isEmpty ? "Untitled record" : record.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .foregroundStyle(.primary)
                HStack(spacing: 6) {
                    Text(record.type)
                    Text("·")
                    Text(record.status)
                    Spacer(minLength: 0)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, 32)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

struct ITSMRecordsView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var selected: ITSMRecord?
    @State private var search = ""
    @State private var filter = "All"
    @State private var showingCreate = false

    private let filters = ["All", "Open", "Incident", "Service Request", "Problem", "Change"]
    private var visible: [ITSMRecord] {
        client.records.filter { record in
            let matchesFilter = filter == "All"
                || (filter == "Open" && record.isOpen)
                || record.type == filter
            let matchesSearch = search.isEmpty
                || [record.id, record.title, record.type, record.status,
                    record.priority, record.requester, record.team,
                    record.assignee, record.service]
                    .joined(separator: " ")
                    .localizedCaseInsensitiveContains(search)
            return matchesFilter && matchesSearch
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Record filter", selection: $filter) {
                ForEach(filters, id: \.self) { Text($0) }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.top, 8)

            if let issue = client.recordsMessage {
                Text(issue).font(.caption).foregroundStyle(.orange)
                    .padding(.horizontal, 16)
            }

            List {
                Section("\(visible.count) records") {
                    ForEach(visible) { record in
                        Button { selected = record } label: {
                            ITSMRecordRow(record: record)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .overlay {
                if visible.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
                        Text(search.isEmpty ? "No records to display" : "No matches")
                            .font(.headline)
                    }
                }
            }
        }
        .navigationTitle("Records")
        .searchable(text: $search, prompt: "Search reference, requester or title")
        .refreshable { await client.refreshRecords() }
        .sheet(isPresented: $showingCreate) {
            ITSMRecordComposer()
                .environmentObject(client)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showingCreate = true
                } label: {
                    Label("New", systemImage: "plus")
                }
                .accessibilityLabel("Create a new ITSM record")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await client.refreshRecords() }
                } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh records")
            }
        }
        .sheet(item: $selected) { record in
            ITSMRecordDetail(record: record).environmentObject(client)
        }
    }
}

struct ITSMRecordDetail: View {
    let record: ITSMRecord
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss

    @State private var current: ITSMRecord?
    @State private var note = ""
    @State private var visibility = "Internal"
    @State private var changing = false
    @State private var message: String?
    @State private var showingResolveWarning = false
    @State private var selectedApproval: ITSMPendingApproval?
    @State private var selectedTask: ITSMTask?
    @State private var editing = false
    #if HI5CENTRAL_UNIFIED
    @EnvironmentObject private var combinedAuth: UnifiedMobileAuth
    @EnvironmentObject private var combinedRMM: RMMClient
    @State private var showingDevicePicker = false
    #endif

    private var item: ITSMRecord { current ?? record }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(item.id).font(.caption.weight(.bold))
                                .foregroundStyle(.tint)
                            Spacer()
                            Text(item.type).font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(item.title).font(.title2.bold())
                        HStack {
                            Label(item.status, systemImage: "circle.inset.filled")
                            Spacer()
                            Label(item.priority, systemImage: "exclamationmark.circle")
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    }
                    .itsmPanel()

                    VStack(alignment: .leading, spacing: 12) {
                        Label("Details", systemImage: "info.circle").font(.headline)
                        detail("Requester", item.requester)
                        detail("Assigned to", item.assignee)
                        detail("Team", item.team)
                        detail("Service", item.service)
                        detail("Category", item.category)
                        detail("Updated", itsmDate(item.updatedAt))
                    }
                    .itsmPanel()

                    #if HI5CENTRAL_UNIFIED
                    if combinedAuth.hasRMM && combinedRMM.authenticated {
                        VStack(alignment: .leading, spacing: 9) {
                            Label("Remote support", systemImage: "desktopcomputer")
                                .font(.headline)
                            Button {
                                showingDevicePicker = true
                            } label: {
                                Label("Find device and open RMM tools",
                                      systemImage: "arrow.up.right.square")
                            }
                            .buttonStyle(.bordered)
                            Text("Search authorised company devices or open the explicitly linked endpoint.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .itsmPanel()
                    }
                    #endif

                    ITSMRecordSupportingSections(
                        record: item,
                        selectedApproval: $selectedApproval,
                        selectedTask: $selectedTask
                    )

                    if !item.description.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Label("Description", systemImage: "text.alignleft").font(.headline)
                            Text(item.description)
                                .font(.subheadline)
                                .textSelection(.enabled)
                        }
                        .itsmPanel()
                    }

                    if !item.isServiceRequest {
                        ITSMRecordActions(
                            busy: changing,
                            onPriority: { value in Task { await change(priority: value) } },
                            onStatus: { value in Task { await change(status: value) } },
                            onTeam: { value in Task { await reassign(team: value) } },
                            onAssignee: { value in Task { await reassign(assignee: value) } }
                        )
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        Label("Activity", systemImage: "text.bubble").font(.headline)

                        if item.activities.isEmpty {
                            Text("No activity yet.").font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(item.activities.enumerated()), id: \.offset) { pair in
                                let activity = pair.element
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(itsmString(activity["actor"]))
                                            .font(.caption.weight(.semibold))
                                        Spacer()
                                        Text(itsmString(activity["visibility"]) == "internal"
                                             ? "Internal" : "Customer")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(itsmString(activity["text"]))
                                        .font(.subheadline)
                                        .textSelection(.enabled)
                                    Text(itsmDate(itsmString(activity["createdAt"])))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 6)
                                Divider()
                            }
                        }

                        if item.isServiceRequest {
                            Text("Service Request activity is read-only in this first native release.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Picker("Visibility", selection: $visibility) {
                                Text("Internal").tag("Internal")
                                Text("Customer").tag("Customer")
                            }
                            .pickerStyle(.segmented)
                            TextEditor(text: $note)
                                .frame(minHeight: 110)
                                .padding(5)
                                .background(Color(uiColor: .tertiarySystemBackground),
                                            in: RoundedRectangle(cornerRadius: 9))
                            Button {
                                Task { await saveNote() }
                            } label: {
                                HStack {
                                    if changing { ProgressView().tint(.white) }
                                    Text("Add \(visibility == "Internal" ? "work note" : "customer reply")")
                                    Image(systemName: "arrow.up")
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                      || changing)
                        }
                    }
                    .itsmPanel()

                    if let message {
                        Label(message, systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                .padding(15)
            }
            .navigationTitle(item.id)
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $selectedApproval) { approval in
                ITSMApprovalDetail(approval: approval).environmentObject(client)
            }
            .sheet(item: $selectedTask) { task in
                ITSMTaskDetail(task: task).environmentObject(client)
            }
            #if HI5CENTRAL_UNIFIED
            .sheet(isPresented: $showingDevicePicker) {
                UnifiedTicketDevicePicker(record: item)
            }
            #endif
            .sheet(isPresented: $editing) {
                ITSMEditRecord(record: item, onUpdated: { updated in
                    current = updated
                })
                .environmentObject(client)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
                if !item.isServiceRequest {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Edit") { editing = true }
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await reload() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh record")
                }
            }
            .task { await reload() }
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(.secondary).font(.subheadline)
            Spacer(minLength: 20)
            Text(value.isEmpty ? "Not set" : value)
                .font(.subheadline.weight(.medium))
                .multilineTextAlignment(.trailing)
        }
    }

    private func reload() async {
        do {
            current = try await client.detail(for: item)
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func saveNote() async {
        let body = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !changing else { return }
        changing = true
        defer { changing = false }
        do {
            current = try await client.postNote(for: item, body: body,
                                                customer: visibility == "Customer")
            note = ""
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func reassign(team: String? = nil, assignee: String? = nil) async {
        guard !changing else { return }
        changing = true
        defer { changing = false }
        do {
            current = try await client.reassign(item, team: team, assignee: assignee)
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func change(status: String? = nil, priority: String? = nil) async {
        guard !changing else { return }
        changing = true
        defer { changing = false }
        do {
            current = try await client.update(item, status: status, priority: priority)
            message = nil
        } catch { message = error.localizedDescription }
    }
}
