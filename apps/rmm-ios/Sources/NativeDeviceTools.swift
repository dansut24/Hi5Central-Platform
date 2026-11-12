import SwiftUI

/// Matches the live tools exposed by the RMM website. The same server-side
/// rmm.devices.control permission applies to both web and native clients.
enum NativeDeviceTool: String, Identifiable, CaseIterable {
    case powershell, cmd, files, processes, services, registry, disks, sessions, events
    case shell

    var id: String { rawValue }
    var title: String {
        switch self {
        case .powershell: "PowerShell"
        case .cmd: "Command Prompt"
        case .shell: "Shell / Terminal"
        case .files: "File browser"
        case .processes: "Task Manager"
        case .services: "Services"
        case .registry: "Registry Editor"
        case .disks: "Disk Management"
        case .sessions: "Users & Sessions"
        case .events: "Event Logs"
        }
    }
    var symbol: String {
        switch self {
        case .powershell, .shell: "terminal"
        case .cmd: "chevron.left.forwardslash.chevron.right"
        case .files: "folder"
        case .processes: "list.bullet.rectangle"
        case .services: "gearshape.2"
        case .registry: "list.bullet.indent"
        case .disks: "externaldrive"
        case .sessions: "person.2"
        case .events: "doc.text.magnifyingglass"
        }
    }
    var subtitle: String {
        switch self {
        case .powershell: "Interactive remote Windows PowerShell"
        case .cmd: "Interactive Windows Command Prompt"
        case .shell: "Interactive Unix PTY"
        case .files: "Browse and transfer device files"
        case .processes: "Inspect, restart or end processes"
        case .services: "Control services and startup settings"
        case .registry: "Browse and edit registry keys"
        case .disks: "Disk capacity, volumes and encryption"
        case .sessions: "Local accounts and logged-in sessions"
        case .events: "System, Application and Security logs"
        }
    }
    static func available(for device: ManagedDevice) -> [NativeDeviceTool] {
        let platform = device.platform.lowercased()
        return platform.contains("linux") || platform.contains("mac")
            ? [.shell, .files]
            : [.powershell, .cmd, .files, .processes, .services,
               .registry, .disks, .sessions, .events]
    }
}

struct NativeDeviceToolScreen: View {
    let device: ManagedDevice
    let tool: NativeDeviceTool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group {
                switch tool {
                case .powershell, .cmd, .shell, .files:
                    NativeLiveToolScreen(device: device, tool: tool)
                case .processes, .services, .registry, .events:
                    NativeDeviceActionScreen(device: device, tool: tool)
                case .disks, .sessions:
                    NativeDeviceInventoryScreen(device: device, tool: tool)
                }
            }
            .navigationTitle(tool.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct ActionConfirmation: Identifiable {
    let id = UUID()
    let title: String
    let action: String
    let payload: [String: Any]
    let isDestructive: Bool
}

struct NativeDeviceActionScreen: View {
    let device: ManagedDevice
    let tool: NativeDeviceTool
    @EnvironmentObject private var client: RMMClient

    @State private var rows: [[String: Any]] = []
    @State private var subkeys: [[String: Any]] = []
    @State private var values: [[String: Any]] = []
    @State private var query = ""
    @State private var busy = false
    @State private var message = ""
    @State private var pending: ActionConfirmation?
    @State private var registryPath = ""
    @State private var pendingNewKey = false
    @State private var newKeyName = ""
    @State private var pendingEditValue = false
    @State private var editValueName = ""
    @State private var editValueText = ""
    @State private var editValueKind = "String"
    @State private var eventLog = "System"
    @State private var eventLevel = "All"

    private var visible: [[String: Any]] {
        guard !query.isEmpty else { return rows }
        return rows.filter { item in
            item.values.map { nativeString($0) }.joined(separator: " ")
                .localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            switch tool {
            case .registry:
                registryView
            case .events:
                eventFilters
                resultsList
            default:
                resultsList
            }
        }
        .task { if tool != .registry { await reload() } }
        .confirmationDialog(pending?.title ?? "Confirm remote action",
                            isPresented: Binding(get: { pending != nil },
                                                 set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible) {
            Button("Confirm action", role: pending?.isDestructive == true ? .destructive : nil) {
                guard let action = pending else { return }
                pending = nil
                Task { await mutate(action) }
            }
            Button("Cancel", role: .cancel) { pending = nil }
        }
        .alert("New registry key", isPresented: $pendingNewKey) {
            TextField("Key name", text: $newKeyName)
            Button("Create") {
                let value = newKeyName.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    Task { await mutate(ActionConfirmation(title: "Create key",
                                                            action: "registry.create_key",
                                                            payload: ["path": registryPath, "name": value],
                                                            isDestructive: false)) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Create a subkey under \(registryPath).")
        }
        .alert("Edit registry value", isPresented: $pendingEditValue) {
            TextField("Value", text: $editValueText)
            Button("Save") {
                Task { await mutate(ActionConfirmation(title: "Edit value",
                                                        action: "registry.set_value",
                                                        payload: ["path": registryPath,
                                                                  "name": editValueName,
                                                                  "value": editValueText,
                                                                  "kind": editValueKind],
                                                        isDestructive: false)) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Change \(editValueName) (\(editValueKind)) on \(device.name).")
        }
    }

    @ViewBuilder
    private var resultsList: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    TextField("Filter \(tool.title.lowercased())", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await reload() }
                    } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(busy || (tool == .registry && registryPath.isEmpty))
                }
                if !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(busy ? Color.secondary : Color.primary)
                }
                if busy { ProgressView().frame(maxWidth: .infinity) }
            }
            if visible.isEmpty && !busy {
                Text("No entries returned.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Array(visible.enumerated()), id: \.offset) { item in
                let record = item.element
                switch tool {
                case .processes: processRow(record)
                case .services: serviceRow(record)
                case .events: eventRow(record)
                default: EmptyView()
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func processRow(_ row: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(nativeText(row, ["name"], fallback: "Unknown process"))
                        .font(.subheadline.weight(.semibold))
                    Text("PID \(nativeText(row, ["pid"])) · CPU \(nativeText(row, ["cpu_seconds"], fallback: "—"))s")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Menu {
                    Button("Restart", systemImage: "arrow.clockwise") {
                        processAction("process.restart", row)
                    }
                    Button("End task", systemImage: "xmark.circle", role: .destructive) {
                        processAction("process.kill", row)
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
            Text("\(nativeText(row, ["working_set_bytes"], fallback: "—")) bytes memory · \(nativeText(row, ["thread_count"], fallback: "—")) threads")
                .font(.caption).foregroundStyle(.secondary)
            let description = nativeText(row, ["window_title", "path"], fallback: "")
            if !description.isEmpty {
                Text(description).font(.caption2).foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    private func processAction(_ type: String, _ row: [String: Any]) {
        let name = nativeText(row, ["name"], fallback: "process")
        let pid = (row["pid"] as? NSNumber)?.intValue ?? 0
        guard pid > 4 else { return }
        pending = ActionConfirmation(
            title: "\(type == "process.kill" ? "End" : "Restart") \(name) (PID \(pid))?",
            action: type, payload: ["pid": pid], isDestructive: true
        )
    }

    @ViewBuilder
    private func serviceRow(_ row: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(nativeText(row, ["display_name", "name"]))
                        .font(.subheadline.weight(.semibold))
                    Text(nativeText(row, ["name"]))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text(nativeText(row, ["state"], fallback: "Unknown"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(nativeString(row["state"]) == "Running" ? Color.green : Color.secondary)
            }
            Text("Start type: \(nativeText(row, ["start_mode"], fallback: "Unknown"))")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("Start") { serviceAction("services.start", row) }
                Button("Stop", role: .destructive) { serviceAction("services.stop", row) }
                Button("Restart") { serviceAction("services.restart", row) }
                Menu("Startup") {
                    ForEach(["Automatic", "AutomaticDelayed", "Manual", "Disabled"], id: \.self) { mode in
                        Button(mode) {
                            serviceAction("services.set_start_type", row, startup: mode)
                        }
                    }
                }
            }
            .font(.caption)
            .buttonStyle(.bordered)
            .disabled(busy)
        }
        .padding(.vertical, 6)
    }

    private func serviceAction(_ type: String, _ row: [String: Any], startup: String = "") {
        let name = nativeText(row, ["name"])
        guard !name.isEmpty else { return }
        var payload: [String: Any] = ["serviceName": name]
        if !startup.isEmpty { payload["startType"] = startup }
        pending = ActionConfirmation(title: "\(type.replacingOccurrences(of: ".", with: " ")) \(name)?",
                                     action: type, payload: payload,
                                     isDestructive: type == "services.stop" || startup == "Disabled")
    }

    @ViewBuilder
    private func eventRow(_ row: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(nativeText(row, ["level"], fallback: "Information"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(nativeString(row["level"]).lowercased().contains("error")
                                     ? Color.red : Color.secondary)
                Spacer()
                Text(nativeText(row, ["event_id"], fallback: "—"))
                    .font(.caption2.monospacedDigit())
                Text(nativeText(row, ["time_created"]))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Text(nativeText(row, ["provider"], fallback: "Windows"))
                .font(.subheadline.weight(.medium))
            Text(nativeText(row, ["message"], fallback: "No details reported"))
                .font(.caption).foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 4)
    }

    private var eventFilters: some View {
        HStack {
            Picker("Log", selection: $eventLog) {
                ForEach(["System", "Application", "Security"], id: \.self) { Text($0) }
            }
            Picker("Level", selection: $eventLevel) {
                ForEach(["All","Critical","Error","Warning","Information","Verbose"], id: \.self) { Text($0) }
            }
            Button {
                Task { await reload() }
            } label: { Image(systemName: "arrow.clockwise") }
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .disabled(busy)
    }

    private var registryView: some View {
        List {
            Section {
                if registryPath.isEmpty {
                    Text("Select a registry hive to browse.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(["HKLM:\\", "HKCU:\\", "HKCR:\\", "HKU:\\", "HKCC:\\"], id: \.self) { hive in
                        Button(hive) { Task { await loadRegistry(hive) } }
                    }
                } else {
                    HStack(spacing: 8) {
                        Button {
                            let trimmed = registryPath.trimmingCharacters(in: CharacterSet(charactersIn: "\\"))
                            if let index = trimmed.lastIndex(of: "\\") {
                                Task { await loadRegistry(String(trimmed[...index])) }
                            } else { registryPath = "" }
                        } label: { Image(systemName: "arrow.left") }
                        TextField("Registry path", text: $registryPath)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.caption.monospaced())
                            .onSubmit { Task { await loadRegistry(registryPath) } }
                        Button { Task { await loadRegistry(registryPath) } }
                            label: { Image(systemName: "arrow.clockwise") }
                    }
                    HStack {
                        Button("Hives") { registryPath = ""; subkeys = []; values = [] }
                        Spacer()
                        Button("New key", systemImage: "folder.badge.plus") {
                            newKeyName = ""
                            pendingNewKey = true
                        }
                    }
                    .font(.caption)
                }
                if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary) }
                if busy { ProgressView().frame(maxWidth: .infinity) }
            }
            if !registryPath.isEmpty {
                Section("Subkeys") {
                    if subkeys.isEmpty && !busy {
                        Text("No subkeys").foregroundStyle(.secondary)
                    }
                    ForEach(Array(subkeys.enumerated()), id: \.offset) { item in
                        let key = item.element
                        let name = nativeText(key, ["name", "path"])
                        Button {
                            let full = nativeText(key, ["path", "full_path"],
                                                  fallback: registryPath + name + "\\")
                            Task { await loadRegistry(full) }
                        } label: {
                            Label(name, systemImage: "folder")
                        }
                        .contextMenu {
                            Button("Delete key", role: .destructive) {
                                let full = nativeText(key, ["path", "full_path"],
                                                      fallback: registryPath + name)
                                pending = ActionConfirmation(title: "Delete registry key \(full)?",
                                                             action: "registry.delete_key",
                                                             payload: ["path": full], isDestructive: true)
                            }
                        }
                    }
                }
                Section("Values") {
                    if values.isEmpty && !busy { Text("No values").foregroundStyle(.secondary) }
                    ForEach(Array(values.enumerated()), id: \.offset) { item in
                        let row = item.element
                        Button {
                            editValueName = nativeText(row, ["name"])
                            editValueText = nativeText(row, ["value"], fallback: "")
                            editValueKind = nativeText(row, ["kind"], fallback: "String")
                            pendingEditValue = true
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(nativeText(row, ["name"], fallback: "(Default)"))
                                    .font(.subheadline.weight(.medium))
                                Text("\(nativeText(row, ["kind"], fallback: "String")) · \(nativeText(row, ["value"], fallback: ""))")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        .contextMenu {
                            Button("Delete value", role: .destructive) {
                                pending = ActionConfirmation(
                                    title: "Delete registry value \(nativeText(row, ["name"]))?",
                                    action: "registry.delete_value",
                                    payload: ["path": registryPath, "name": nativeText(row, ["name"])],
                                    isDestructive: true)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func loadRegistry(_ target: String) async {
        guard target.hasPrefix("HK"), !busy else { return }
        busy = true
        message = "Reading registry…"
        defer { busy = false }
        do {
            let result = try await client.deviceAction(for: device, type: "registry.list",
                                                       payload: ["path": target])
            let data = nativeDict(result["result"])
            subkeys = nativeRows(data["subkeys"])
            values = nativeRows(data["values"])
            registryPath = target
            message = "Loaded \(subkeys.count) keys and \(values.count) values"
        } catch { message = error.localizedDescription }
    }

    private func reload() async {
        guard device.isOnline, !busy else { return }
        busy = true
        message = "Loading \(tool.title)…"
        defer { busy = false }
        let action: String
        var payload: [String: Any] = [:]
        switch tool {
        case .processes: action = "processes.list"
        case .services: action = "services.list"
        case .events:
            action = "events.list"
            payload = ["logName": eventLog, "level": eventLevel, "maxEvents": 100]
        case .registry:
            busy = false
            await loadRegistry(registryPath)
            return
        default: busy = false; return
        }
        do {
            let job = try await client.deviceAction(for: device, type: action, payload: payload)
            let data = nativeDict(job["result"])
            let field = tool == .processes ? "processes" : (tool == .services ? "services" : "events")
            rows = nativeRows(data[field])
            message = "\(rows.count) \(tool.title.lowercased()) records loaded"
        } catch {
            message = error.localizedDescription
        }
    }

    private func mutate(_ action: ActionConfirmation) async {
        guard !busy else { return }
        busy = true
        message = "Applying \(action.action)…"
        do {
            _ = try await client.deviceAction(for: device, type: action.action,
                                              payload: action.payload)
            busy = false
            message = "Action completed successfully"
            if tool == .registry {
                if action.action == "registry.delete_key",
                   let path = action.payload["path"] as? String {
                    let parts = path.split(separator: "\\")
                    let parent = parts.dropLast().joined(separator: "\\") + "\\"
                    await loadRegistry(parent)
                } else {
                    await loadRegistry(registryPath)
                }
            } else {
                await reload()
            }
        } catch {
            busy = false
            message = error.localizedDescription
        }
    }
}

struct NativeDeviceInventoryScreen: View {
    let device: ManagedDevice
    let tool: NativeDeviceTool

    var body: some View {
        List {
            if tool == .disks {
                let disks = nativeRows(device.inventory["storage"])
                Section("Storage volumes") {
                    if disks.isEmpty {
                        Text("Waiting for storage telemetry from the Agent.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(disks.enumerated()), id: \.offset) { item in
                        let disk = item.element
                        VStack(alignment: .leading, spacing: 8) {
                            Label(nativeText(disk, ["drive", "mount"], fallback: "Volume"),
                                  systemImage: "internaldrive")
                                .font(.headline)
                            Text(nativeText(disk, ["label", "filesystem"], fallback: "Disk"))
                                .font(.caption).foregroundStyle(.secondary)
                            let used = (disk["used_percent"] as? NSNumber)?.doubleValue ?? 0
                            ProgressView(value: min(100, max(0, used)), total: 100)
                            Text("\(used, specifier: "%.0f")% used")
                                .font(.caption)
                            HStack {
                                Text("BitLocker: " + nativeText(disk, ["bitlocker_status"], fallback: "Not reported"))
                                Spacer()
                                Text(nativeText(disk, ["free_bytes"], fallback: "—") + " bytes free")
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                let sessions = nativeDict(device.inventory["sessions"])
                let locals = nativeDict(device.inventory["local_users"])
                let security = nativeDict(device.inventory["security"])
                Section("Signed-in users") {
                    LabeledContent("Console user", value: nativeText(sessions, ["console_user"]))
                    LabeledContent("RDP sessions", value: nativeText(sessions, ["rdp_sessions"]))
                }
                Section("Local accounts") {
                    let users = nativeRows(locals["users"])
                    if users.isEmpty { Text("No local account inventory reported.").foregroundStyle(.secondary) }
                    ForEach(Array(users.enumerated()), id: \.offset) { item in
                        let user = item.element
                        VStack(alignment: .leading, spacing: 3) {
                            Text(nativeText(user, ["name"], fallback: "User"))
                                .font(.subheadline.weight(.medium))
                            Text(nativeText(user, ["description", "full_name", "sid"], fallback: ""))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Local administrators") {
                    let admins = nativeRows(security["local_admins"])
                    ForEach(Array(admins.enumerated()), id: \.offset) { item in
                        Text(nativeText(item.element, ["name"], fallback: "Administrator"))
                    }
                    if admins.isEmpty { Text("No administrator list reported.").foregroundStyle(.secondary) }
                }
                Section("Interactive sessions") {
                    ForEach(Array(nativeRows(sessions["sessions"]).enumerated()), id: \.offset) { item in
                        let row = item.element
                        VStack(alignment: .leading) {
                            Text(nativeText(row, ["user"], fallback: "System"))
                            Text("Session \(nativeText(row, ["id"])) · \(nativeText(row, ["station", "state"]))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}
