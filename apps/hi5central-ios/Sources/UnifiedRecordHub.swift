import SwiftUI

/// ITSM queue designed for a compact iPhone screen. It reuses the existing
/// authorised record client and native record detail/editor.
struct UnifiedRecordHub: View {
    @EnvironmentObject private var itsm: ITSMClient

    @State private var query = ""
    @State private var view = "All"
    @State private var type = "Any"
    @State private var selected: ITSMRecord?
    @State private var creating = false
    @State private var showingCatalogue = false

    private var records: [ITSMRecord] {
        itsm.records.filter { item in
            let matchesView: Bool
            switch view {
            case "Open": matchesView = item.isOpen
            case "Mine":
                matchesView = !itsm.userName.isEmpty
                    && item.assignee.localizedCaseInsensitiveCompare(itsm.userName)
                        == .orderedSame
            default: matchesView = true
            }
            let matchesType = type == "Any" || item.type == type
            let matchesSearch = query.isEmpty || [
                item.id, item.title, item.type, item.status, item.priority,
                item.requester, item.team, item.assignee, item.service, item.category
            ].joined(separator: " ").localizedCaseInsensitiveContains(query)
            return matchesView && matchesType && matchesSearch
        }
    }

    private var openCount: Int { itsm.records.filter(\.isOpen).count }
    private var myCount: Int {
        guard !itsm.userName.isEmpty else { return 0 }
        return itsm.records.filter {
            $0.assignee.localizedCaseInsensitiveCompare(itsm.userName) == .orderedSame
        }.count
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 11) {
                HStack(spacing: 8) {
                    counter("Open", value: openCount, symbol: "tray.full", colour: .orange)
                    counter("Assigned to me", value: myCount,
                            symbol: "person.crop.circle", colour: .blue)
                }

                Picker("Queue view", selection: $view) {
                    Text("All").tag("All")
                    Text("Open").tag("Open")
                    Text("Mine").tag("Mine")
                }
                .pickerStyle(.segmented)

                HStack {
                    Menu {
                        Button("All record types") { type = "Any" }
                        Divider()
                        ForEach(["Incident", "Service Request", "Problem", "Change"], id: \.self) { value in
                            Button(value) { type = value }
                        }
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: "line.3.horizontal.decrease")
                            Text(type == "Any" ? "All record types" : type)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.caption2)
                        }
                        .font(.subheadline.weight(.medium))
                    }
                    Spacer()
                    Text("Showing \(records.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 5)

            List {
                if let issue = itsm.recordsMessage {
                    Section {
                        Label(issue, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                Section {
                    if records.isEmpty {
                        Label(query.isEmpty ? "No records in this view" : "No matching records",
                              systemImage: "tray")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(records) { record in
                        Button { selected = record } label: {
                            ITSMRecordRow(record: record)
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("Records you can access")
                } footer: {
                    Text("Counts and filters apply to records returned to your account. Service Requests use their dedicated fulfilment workflow.")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Records")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Reference, title, requester or assignee")
        .refreshable { await itsm.refreshRecords() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        creating = true
                    } label: {
                        Label("New Incident, Problem or Change", systemImage: "ticket")
                    }
                    Button {
                        showingCatalogue = true
                    } label: {
                        Label("New Service Request", systemImage: "shippingbox")
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Create a new record or Service Request")
            }
        }
        .sheet(isPresented: $creating) {
            ITSMRecordComposer().environmentObject(itsm)
        }
        .sheet(isPresented: $showingCatalogue) {
            NavigationStack {
                UnifiedServiceCatalogueView()
            }
            .environmentObject(itsm)
        }
        .sheet(item: $selected) { record in
            ITSMRecordDetail(record: record).environmentObject(itsm)
        }
    }

    private func counter(_ title: String, value: Int,
                         symbol: String, colour: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(colour)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(String(value))
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .padding(11)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 12))
    }
}
