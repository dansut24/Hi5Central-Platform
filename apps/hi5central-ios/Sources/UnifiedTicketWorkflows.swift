import SwiftUI

/// v0.4 native lifecycle. Status changes remain validated by the tenant API.
struct UnifiedTicketLifecyclePanel: View {
    @EnvironmentObject private var client: ITSMClient
    let record: ITSMRecord
    let onUpdated: (ITSMRecord) -> Void
    @State private var targetStatus = ""
    @State private var note = ""
    @State private var confirming = false
    @State private var busy = false
    @State private var issue: String?

    private var finished: Bool {
        ["Resolved", "Closed", "Completed", "Cancelled"].contains(record.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Record lifecycle", systemImage: "checkmark.seal")
                .font(.headline)
            Text(finished ? "Reopen this record when further work is required." :
                    "Record a resolution outcome before closing this record.")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if !finished {
                    Button {
                        propose("Resolved")
                    } label: {
                        Label("Resolve", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(.borderedProminent)
                }
                if record.status == "Resolved" {
                    Button {
                        propose("Closed")
                    } label: {
                        Label("Close", systemImage: "checkmark.seal.fill")
                    }
                    .buttonStyle(.borderedProminent)
                }
                if finished {
                    Button {
                        Task { await reopen() }
                    } label: {
                        Label("Reopen", systemImage: "arrow.uturn.backward")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .disabled(busy)
            if busy { ProgressView("Updating…") }
            if let issue {
                Label(issue, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
        }
        .itsmPanel()
        .sheet(isPresented: $confirming) {
            NavigationStack {
                Form {
                    Section {
                        Text("Move \(record.id) to \(targetStatus)?")
                            .font(.headline)
                        TextEditor(text: $note)
                            .frame(minHeight: 130)
                            .accessibilityLabel("Outcome note")
                    } header: {
                        Text("Required outcome")
                    } footer: {
                        Text("The internal note is saved before the status update. If the status request fails, the note remains in the audit trail.")
                    }
                }
                .navigationTitle(targetStatus == "Closed" ? "Close" : "Resolve")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { confirming = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Confirm") {
                            confirming = false
                            Task { await confirmChange() }
                        }
                        .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func propose(_ status: String) {
        targetStatus = status
        note = ""
        issue = nil
        confirming = true
    }

    private func confirmChange() async {
        let clean = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let withNote = try await client.postNote(
                for: record, body: "\(targetStatus) outcome: \(clean)", customer: false)
            do {
                let updated = try await client.update(withNote, status: targetStatus, priority: nil)
                onUpdated(updated)
                issue = nil
            } catch {
                onUpdated(withNote)
                issue = "Note saved; status change failed: \(error.localizedDescription)"
            }
        } catch { issue = error.localizedDescription }
    }

    private func reopen() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            onUpdated(try await client.update(record, status: "In Progress", priority: nil))
            issue = nil
        } catch { issue = error.localizedDescription }
    }
}

/// Native conversation history and validated work note/customer reply.
struct UnifiedTicketActivityPanel: View {
    @EnvironmentObject private var client: ITSMClient
    let record: ITSMRecord
    let onUpdated: (ITSMRecord) -> Void
    @State private var filter = "All"
    @State private var visibility = "Internal"
    @State private var note = ""
    @State private var busy = false
    @State private var issue: String?

    private var updates: [[String: Any]] {
        record.activities.filter { row in
            filter == "All" ||
            (filter == "Internal" && itsmString(row["visibility"]) == "internal") ||
            (filter == "Customer" && itsmString(row["visibility"]) != "internal")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Activity", systemImage: "text.bubble").font(.headline)
                Spacer()
                Text("\(updates.count) updates").font(.caption).foregroundStyle(.secondary)
            }
            Picker("Activity filter", selection: $filter) {
                Text("All").tag("All")
                Text("Internal").tag("Internal")
                Text("Customer").tag("Customer")
            }
            .pickerStyle(.segmented)
            if updates.isEmpty {
                Text("No activity matches this filter.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Array(updates.enumerated()), id: \.offset) { pair in
                let item = pair.element
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(itsmString(item["actor"]).isEmpty
                             ? "Hi5Central" : itsmString(item["actor"]))
                            .font(.caption.weight(.semibold))
                        Spacer()
                        Text(itsmString(item["visibility"]) == "internal" ? "Internal" : "Customer")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(itsmString(item["text"]))
                        .font(.subheadline).textSelection(.enabled)
                    Text(itsmDate(itsmString(item["createdAt"])))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.vertical, 5)
                Divider()
            }
            Text("New activity").font(.subheadline.weight(.semibold))
                Picker("Visibility", selection: $visibility) {
                    Text("Internal note").tag("Internal")
                    Text("Customer reply").tag("Customer")
                }
                .pickerStyle(.segmented)
                TextEditor(text: $note)
                    .frame(minHeight: 105)
                    .padding(5)
                    .background(Color(uiColor: .tertiarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 10))
                HStack {
                    Text("\(note.count)/20,000").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        Task { await post() }
                    } label: {
                        Label("Post update", systemImage: "arrow.up")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                              note.count > 20_000 || busy)
                }
                if busy { ProgressView("Posting…") }
            if let issue {
                Label(issue, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
            }
        }
        .itsmPanel()
    }

    private func post() async {
        let clean = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 20_000, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            if record.isServiceRequest {
                onUpdated(try await client.postServiceRequestNote(
                    for: record, body: clean, customer: visibility == "Customer"))
            } else {
                onUpdated(try await client.postNote(
                    for: record, body: clean, customer: visibility == "Customer"))
            }
            note = ""
            issue = nil
        } catch { issue = error.localizedDescription }
    }
}
