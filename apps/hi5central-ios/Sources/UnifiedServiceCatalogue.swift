import SwiftUI
import UniformTypeIdentifiers

/// Service Catalogue items are the server-authorised source of request forms.
struct UnifiedCatalogueItem: Identifiable {
    let raw: [String: Any]
    var id: String { itsmString(raw["id"]) }
    var title: String { itsmString(raw["title"]) }
    var description: String { itsmString(raw["description"]) }
    var category: String { itsmString(raw["category"]) }
    var approval: String { itsmString(raw["approval"]) }
    var fields: [[String: Any]] { itsmRows(raw["formSchema"]) }
}

struct UnifiedServiceCatalogueView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var items: [UnifiedCatalogueItem] = []
    @State private var query = ""
    @State private var chosen: UnifiedCatalogueItem?
    @State private var created: ITSMRecord?
    @State private var loading = false
    @State private var error: String?

    private var filtered: [UnifiedCatalogueItem] {
        items.filter {
            query.isEmpty || [$0.title, $0.category, $0.description]
                .joined(separator: " ").localizedCaseInsensitiveContains(query)
        }.sorted { a,b in
            a.category == b.category ? a.title < b.title : a.category < b.category
        }
    }

    var body: some View {
        List {
            Section {
                if loading && items.isEmpty { ProgressView("Loading catalogue…") }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.orange)
                    Button("Retry") { Task { await load() } }
                }
                if !loading && error == nil && filtered.isEmpty {
                    Label("No available request forms", systemImage: "tray")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(filtered) { item in
                    Button { chosen = item } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.title).font(.headline).foregroundStyle(.primary)
                            Text(item.category.isEmpty ? "Service Catalogue" : item.category)
                                .font(.caption).foregroundStyle(.secondary)
                            if !item.description.isEmpty {
                                Text(item.description).font(.subheadline)
                                    .foregroundStyle(.secondary).lineLimit(3)
                            }
                            if !item.approval.isEmpty && item.approval != "none" {
                                Label("Approval may be required", systemImage: "checkmark.shield")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("Request a service")
            } footer: {
                Text("Only active, visible Service Request forms from your company's catalogue are shown. Approvals, pricing and fulfilment are enforced by the server.")
            }
        }
        .navigationTitle("Service Requests")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search services")
        .refreshable { await load() }
        .task { if items.isEmpty { await load() } }
        .sheet(item: $chosen) { item in
            UnifiedServiceRequestComposer(item: item) { record in
                chosen = nil
                created = record
            }
            .environmentObject(client)
        }
        .sheet(item: $created) { record in
            ITSMRecordDetail(record: record).environmentObject(client)
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            items = try await client.mobileServiceCatalogue()
                .map { UnifiedCatalogueItem(raw: $0) }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

/// Render common catalogue field types, and block unknown required inputs rather
/// than submitting incomplete or misleading forms.
struct UnifiedRequestFormField: View {
    @EnvironmentObject private var client: ITSMClient
    let field: [String: Any]
    @Binding var values: [String: Any]
    var id: String { itsmString(field["id"]) }
    var title: String { itsmString(field["label"]) }
    var type: String { itsmString(field["type"]).lowercased() }
    var required: Bool { field["required"] as? Bool == true }

    private struct Option: Identifiable {
        let id: String
        let name: String
    }

    private var choices: [Option] {
        let raw = field["options"] as? [Any] ?? []
        return raw.compactMap { value in
            if let row = value as? [String: Any] {
                let key = itsmString(row["value"])
                let label = itsmString(row["label"])
                return key.isEmpty ? nil : Option(id: key, name: label.isEmpty ? key : label)
            }
            let value = itsmString(value)
            return value.isEmpty ? nil : Option(id: value, name: value)
        }
    }

    static let lookupSources = Set(["people", "departments", "sites", "teams"])

    private var lookupOptions: [Option] {
        let source = itsmString(field["source"]).lowercased()
        let rows: [[String: Any]]
        switch source {
        case "people": rows = client.people
        case "departments": rows = client.departments
        case "sites": rows = client.sites
        case "teams": rows = client.teams
        default: rows = []
        }
        return rows.compactMap { row in
            guard (row["active"] as? Bool) != false else { return nil }
            let key = itsmString(row["externalKey"])
            let name = itsmString(row["name"])
            return key.isEmpty || name.isEmpty ? nil : Option(id: key, name: name)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var catalogueDateFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.isLenient = false
        formatter.dateFormat = type == "datetime-local" ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd"
        return formatter
    }

    private var dateSelection: Binding<Date> {
        Binding(
            get: {
                catalogueDateFormatter.date(from: itsmString(values[id])) ?? Date()
            },
            set: {
                values[id] = catalogueDateFormatter.string(from: $0)
            }
        )
    }

    private var textValue: Binding<String> {
        Binding(get: { itsmString(values[id]) }, set: { values[id] = $0 })
    }
    private var booleanValue: Binding<Bool> {
        Binding(get: { values[id] as? Bool ?? false }, set: { values[id] = $0 })
    }
    private func selected(_ value: String) -> Bool {
        (values[id] as? [String] ?? []).contains(value)
    }
    private func setSelected(_ value: String, enabled: Bool) {
        var selected = Set(values[id] as? [String] ?? [])
        if enabled { selected.insert(value) } else { selected.remove(value) }
        values[id] = Array(selected).sorted()
    }

    static let supported = Set([
        "text", "textarea", "email", "number", "date", "select", "dropdown",
        "radio", "product", "checkbox", "checkbox-products",
        "multiselect", "multi-select", "checkboxes", "lookup", "section",
        "datetime-local"
    ])

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if type != "section" {
                HStack {
                    Text(title.isEmpty ? id : title).font(.subheadline.weight(.semibold))
                    if required { Text("Required").font(.caption2).foregroundStyle(.red) }
                }
            }
            switch type {
            case "section":
                Text(title.isEmpty ? "Request details" : title)
                    .font(.headline).padding(.top, 8)
                let help = itsmString(field["help"])
                if !help.isEmpty {
                    Text(help).font(.caption).foregroundStyle(.secondary)
                }
            case "lookup":
                Picker(title, selection: textValue) {
                    Text("Select…").tag("")
                    ForEach(lookupOptions) { option in
                        Text(option.name).tag(option.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .accessibilityLabel(title)
                if lookupOptions.isEmpty {
                    Text("No matching \(itsmString(field["source"])) records available. Add them under People & Organisation, refresh and retry.")
                        .font(.caption).foregroundStyle(.orange)
                }
            case "textarea":
                TextEditor(text: textValue)
                    .frame(minHeight: 85)
                    .padding(5)
                    .background(Color(uiColor: .tertiarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 8))
            case "checkbox":
                Toggle("Yes", isOn: booleanValue)
            case "select", "dropdown", "radio", "product":
                Picker(title, selection: textValue) {
                    Text("Select…").tag("")
                    ForEach(choices) { value in
                        Text(value.name).tag(value.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .accessibilityLabel(title)
                if choices.isEmpty {
                    Text("No choices available for this field. Update the catalogue or use the web workspace.")
                        .font(.caption).foregroundStyle(.orange)
                }
            case "checkbox-products", "multiselect", "multi-select", "checkboxes":
                ForEach(choices) { option in
                    Toggle(option.name, isOn: Binding(
                        get: { selected(option.id) },
                        set: { setSelected(option.id, enabled: $0) }))
                }
                if choices.isEmpty {
                    Text("No choices available for this field.")
                        .font(.caption).foregroundStyle(.orange)
                }
            case "date", "datetime-local":
                if itsmString(values[id]).isEmpty {
                    Button {
                        values[id] = catalogueDateFormatter.string(from: Date())
                    } label: {
                        Label(type == "date" ? "Choose date" : "Choose date and time",
                              systemImage: "calendar")
                    }
                    .accessibilityLabel(title)
                } else {
                    HStack {
                        DatePicker(
                            title,
                            selection: dateSelection,
                            displayedComponents: type == "date"
                                ? [.date] : [.date, .hourAndMinute]
                        )
                        .datePickerStyle(.compact)
                        .labelsHidden()
                        .accessibilityLabel(title)
                        Spacer(minLength: 5)
                        Button("Clear") { values[id] = "" }
                            .font(.caption)
                            .accessibilityLabel("Clear " + title)
                    }
                }
            case "text", "email", "number":
                TextField(title, text: textValue)
                    .textInputAutocapitalization(type == "email" ? .never : .sentences)
                    .keyboardType(type == "email" ? .emailAddress :
                                    type == "number" ? .decimalPad : .default)
                    .textFieldStyle(.roundedBorder)
            default:
                Text("This field type (\(type)) is not yet supported in the iPhone form.")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 5)
    }
}

struct UnifiedServiceRequestComposer: View {
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    let item: UnifiedCatalogueItem
    let onCreated: (ITSMRecord) -> Void

    @State private var summary = ""
    @State private var details = ""
    @State private var priority = "Medium"
    @State private var requesterId = ""
    @State private var values: [String: Any] = [:]
    @State private var saving = false
    @State private var error: String?

    /// Catalogue "section" markers become actual native Form sections rather than
    /// unsupported input rows. Conditional fields remain in their original order.
    private struct FormGroup: Identifiable {
        let id: String
        let title: String
        let help: String
        var fields: [[String: Any]]
    }

    private var formGroups: [FormGroup] {
        var groups: [FormGroup] = []
        for (index, field) in visibleFields.enumerated() {
            let type = itsmString(field["type"]).lowercased()
            if type == "section" {
                groups.append(FormGroup(
                    id: "section-\(index)",
                    title: itsmString(field["label"]),
                    help: itsmString(field["help"]),
                    fields: []
                ))
            } else {
                if groups.isEmpty {
                    groups.append(FormGroup(
                        id: "catalogue-start", title: "Catalogue form", help: "", fields: []
                    ))
                }
                groups[groups.count - 1].fields.append(field)
            }
        }
        return groups.filter { !$0.fields.isEmpty }
    }

    private var visibleFields: [[String: Any]] {
        item.fields.filter { field in
            let condition = itsmDict(field["showWhen"])
            if condition.isEmpty { return true }
            let source = itsmString(condition["field"])
            let current = values[source]
            if let equal = condition["equals"] {
                return String(describing: current ?? "") == String(describing: equal)
            }
            if let oneOf = condition["oneOf"] as? [Any] {
                return oneOf.contains { String(describing: $0) == String(describing: current ?? "") }
            }
            return true
        }
    }
    private var missingRequired: [String] {
        visibleFields.filter { field in
            guard field["required"] as? Bool == true,
                  itsmString(field["type"]).lowercased() != "section" else { return false }
            let id = itsmString(field["id"])
            let value = values[id]
            if let bool = value as? Bool { return !bool }
            if let array = value as? [String] { return array.isEmpty }
            return itsmString(value).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }.map { itsmString($0["label"]) }
    }
    private var unsupportedFields: [String] {
        visibleFields.filter { field in
            let type = itsmString(field["type"]).lowercased()
            if !UnifiedRequestFormField.supported.contains(type) { return true }
            if type == "lookup" {
                return !UnifiedRequestFormField.lookupSources.contains(
                    itsmString(field["source"]).lowercased()
                )
            }
            return false
        }.map { itsmString($0["label"]) }
    }

    private var missingRequiredOptions: [String] {
        visibleFields.filter { field in
            guard field["required"] as? Bool == true else { return false }
            let type = itsmString(field["type"]).lowercased()
            if type == "lookup" {
                let source = itsmString(field["source"]).lowercased()
                let rows: [[String: Any]]
                switch source {
                case "people": rows = client.people
                case "departments": rows = client.departments
                case "sites": rows = client.sites
                case "teams": rows = client.teams
                default: return false // unknown source is reported as unsupported
                }
                return !rows.contains(where: {
                    ($0["active"] as? Bool) != false &&
                    !itsmString($0["externalKey"]).isEmpty
                })
            }
            let optionsNeeded = [
                "select", "dropdown", "radio", "product",
                "checkbox-products", "multiselect", "multi-select", "checkboxes"
            ]
            return optionsNeeded.contains(type) &&
                (field["options"] as? [Any] ?? []).isEmpty
        }.map { itsmString($0["label"]) }
    }

    private var unhandledFields: [String] {
        unsupportedFields + missingRequiredOptions
    }

    private var selectablePeople: [[String: Any]] {
        client.people.filter { ($0["active"] as? Bool) != false &&
                               !itsmString($0["externalKey"]).isEmpty }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(item.title).font(.headline)
                    if !item.description.isEmpty {
                        Text(item.description).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text(item.category).font(.caption).foregroundStyle(.secondary)
                }
                Section("Request details") {
                    TextField("Summary", text: $summary)
                    VStack(alignment: .leading, spacing: 7) {
                        Text("Description").font(.subheadline)
                        TextEditor(text: $details).frame(minHeight: 80)
                    }
                    Picker("Urgency", selection: $priority) {
                        ForEach(["Low","Medium","High","Critical"], id: \.self) { value in
                            Text(value).tag(value)
                        }
                    }
                    if !selectablePeople.isEmpty {
                        Picker("Request for", selection: $requesterId) {
                            Text("Myself").tag("")
                            ForEach(Array(selectablePeople.enumerated()), id: \.offset) { pair in
                                Text(itsmString(pair.element["name"]))
                                    .tag(itsmString(pair.element["externalKey"]))
                            }
                        }
                    }
                }
                ForEach(formGroups) { group in
                    Section {
                        ForEach(Array(group.fields.enumerated()), id: \.offset) { pair in
                            UnifiedRequestFormField(field: pair.element, values: $values)
                        }
                    } header: {
                        Text(group.title)
                    } footer: {
                        if !group.help.isEmpty {
                            Text(group.help)
                        }
                    }
                }
                if !unsupportedFields.isEmpty {
                    Section {
                        Text("Unsupported form fields: \(unsupportedFields.joined(separator: ", ")). Use the web workspace for these fields.")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                }
                if !missingRequiredOptions.isEmpty {
                    Section {
                        Text("This company needs catalogue options or People & Organisation records before these required fields can be completed: \(missingRequiredOptions.joined(separator: ", ")).")
                            .font(.footnote).foregroundStyle(.orange)
                        Button("Refresh organisation") {
                            Task { await client.refreshOrganisation() }
                        }
                    }
                }
                if unhandledFields.isEmpty && !missingRequired.isEmpty {
                    Section {
                        Text("Required fields: \(missingRequired.joined(separator: ", "))")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("New Service Request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") { Task { await submit() } }
                        .disabled(saving || summary.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 ||
                                  summary.count > 240 || details.count > 20_000 ||
                                  !missingRequired.isEmpty || !unhandledFields.isEmpty)
                }
            }
            .onAppear { if summary.isEmpty { summary = item.title } }
            .task { await client.refreshOrganisation() }
            .overlay {
                if saving { ProgressView("Submitting request…") }
            }
        }
    }

    private func submit() async {
        guard !saving, missingRequired.isEmpty, unhandledFields.isEmpty else { return }
        saving = true
        defer { saving = false }
        do {
            // Do not leak stale values from fields hidden by conditional rules.
            let activeKeys = Set(visibleFields.compactMap { field -> String? in
                guard itsmString(field["type"]).lowercased() != "section" else { return nil }
                let key = itsmString(field["id"])
                return key.isEmpty ? nil : key
            })
            let submittedValues = values.filter { activeKeys.contains($0.key) }
            let record = try await client.newServiceRequest(
                itemKey: item.id, summary: summary, details: details,
                priority: priority, values: submittedValues, requesterPersonId: requesterId)
            onCreated(record)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
