import SwiftUI
import UniformTypeIdentifiers

struct NativeLiveToolScreen: View {
    let device: ManagedDevice
    let tool: NativeDeviceTool
    @EnvironmentObject private var client: RMMClient
    @StateObject private var socket = NativeToolSocket()
    @State private var runAs = "system"
    @State private var command = ""
    @State private var search = ""
    @State private var showImporter = false
    @State private var showNewFolder = false
    @State private var newFolderName = ""
    @State private var renameEntry: [String: Any]?
    @State private var renameText = ""
    @State private var showRename = false
    @State private var deleteEntry: [String: Any]?

    private var unix: Bool {
        let name = device.platform.lowercased()
        return name.contains("mac") || name.contains("linux")
    }

    private var visibleFiles: [[String: Any]] {
        guard !search.isEmpty else { return socket.files }
        return socket.files.filter {
            nativeText($0, ["name", "full_path"])
                .localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Picker("Execution context", selection: $runAs) {
                    Text(unix ? "Root" : "SYSTEM").tag("system")
                    Text("Signed-in user").tag("user")
                }
                .pickerStyle(.segmented)
                .disabled(socket.busyTransfer)
                Button {
                    Task { await reconnect() }
                } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Reconnect remote tool")
            }
            .padding(12)
            HStack(spacing: 7) {
                Circle()
                    .fill(socket.connected ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text(socket.status)
                    .font(.caption)
                    .lineLimit(2)
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 15)
            .padding(.bottom, 8)
            Divider()
            if tool == .files {
                fileBrowser
            } else {
                terminal
            }
        }
        .task { await reconnect() }
        .onChange(of: runAs) { _ in Task { await reconnect() } }
        .onDisappear { socket.disconnect() }
        .fileImporter(isPresented: $showImporter,
                      allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let files):
                guard let url = files.first else { return }
                Task { await socket.upload(url) }
            case .failure:
                break
            }
        }
        .alert("New folder", isPresented: $showNewFolder) {
            TextField("Folder name", text: $newFolderName)
            Button("Create") { socket.createFolder(newFolderName) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Create a folder in \(socket.path)")
        }
        .alert("Rename file", isPresented: $showRename) {
            TextField("New name", text: $renameText)
            Button("Rename") {
                if let entry = renameEntry { socket.rename(entry, to: renameText) }
                renameEntry = nil
            }
            Button("Cancel", role: .cancel) { renameEntry = nil }
        }
        .confirmationDialog("Delete remote file or folder?",
                            isPresented: Binding(get: { deleteEntry != nil },
                                                 set: { if !$0 { deleteEntry = nil } }),
                            titleVisibility: .visible) {
            Button("Delete on remote device", role: .destructive) {
                if let entry = deleteEntry { socket.delete(entry) }
                deleteEntry = nil
            }
            Button("Cancel", role: .cancel) { deleteEntry = nil }
        } message: {
            Text("This action affects the selected device and may not be reversible.")
        }
    }

    private func reconnect() async {
        socket.disconnect()
        do {
            let shell: String = tool == .cmd ? "cmd" : (unix ? "shell" : "powershell")
            let session = try await client.openLiveTool(for: device,
                                                        tool: tool == .files ? "files" : "terminal",
                                                        shell: shell,
                                                        runAs: runAs)
            socket.connect(session, initialPath: unix ? "/" : "C:\\")
        } catch {
            socket.showError(error.localizedDescription)
        }
    }

    private var terminal: some View {
        VStack(spacing: 0) {
            ScrollViewReader { reader in
                ScrollView {
                    Text(socket.terminalOutput.isEmpty ? "Remote terminal output will appear here." :
                         socket.terminalOutput)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(socket.terminalOutput.isEmpty ? Color.secondary : Color.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(15)
                    Color.clear.frame(height: 1).id("bottom")
                }
                .background(Color(uiColor: .secondarySystemBackground))
                .onChange(of: socket.terminalOutput.count) { _ in
                    withAnimation(.easeOut(duration: 0.1)) { reader.scrollTo("bottom", anchor: .bottom) }
                }
            }
            Divider()
            HStack(spacing: 8) {
                TextField("Enter remote command", text: $command, axis: .vertical)
                    .font(.system(size: 14, design: .monospaced))
                    .lineLimit(1...3)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { submitCommand() }
                    .submitLabel(.send)
                Button("Ctrl+C") {
                    socket.send(["type": "terminal_input", "data": "\u{03}"])
                }
                .font(.caption)
                .disabled(!socket.connected)
                Button { submitCommand() } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 29))
                }
                .disabled(!socket.connected || command.isEmpty)
            }
            .padding(12)
        }
    }

    private func submitCommand() {
        let value = command
        guard !value.isEmpty else { return }
        socket.run(value)
        command = ""
    }

    private var fileBrowser: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    socket.list(socket.parent)
                } label: { Image(systemName: "arrow.left") }
                    .disabled(!socket.connected || socket.parent.isEmpty)
                Text(socket.path.isEmpty ? "Loading folders…" : socket.path)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button {
                    socket.list(socket.path)
                } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(!socket.connected)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            if !socket.drives.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(socket.drives.enumerated()), id: \.offset) { item in
                            let drive = item.element
                            Button {
                                socket.list(nativeText(drive, ["root", "path"]))
                            } label: {
                                Label(nativeText(drive, ["name", "root"]),
                                      systemImage: "externaldrive")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }
            HStack(spacing: 8) {
                TextField("Search this folder", text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    newFolderName = ""
                    showNewFolder = true
                } label: { Image(systemName: "folder.badge.plus") }
                    .accessibilityLabel("New folder")
                Button {
                    showImporter = true
                } label: { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Upload file to device")
            }
            .padding(12)
            .disabled(!socket.connected || socket.busyTransfer)

            if let file = socket.downloadedURL {
                HStack {
                    Label("Download ready: \(socket.downloadedName)", systemImage: "checkmark.circle.fill")
                        .lineLimit(1)
                        .font(.caption)
                    Spacer()
                    ShareLink(item: file) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    .font(.caption)
                }
                .padding(.horizontal, 13)
                .padding(.bottom, 7)
            }

            List {
                ForEach(Array(visibleFiles.enumerated()), id: \.offset) { item in
                    let entry = item.element
                    let isFolder = nativeString(entry["type"]) == "folder"
                    HStack(spacing: 11) {
                        Image(systemName: isFolder ? "folder.fill" : "doc")
                            .foregroundStyle(isFolder ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(nativeText(entry, ["name"], fallback: "Unnamed"))
                                .font(.subheadline.weight(.medium))
                                .lineLimit(2)
                            if !isFolder {
                                Text("\(nativeText(entry, ["size_bytes"], fallback: "—")) bytes")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 5)
                        if isFolder {
                            Button {
                                socket.list(nativeText(entry, ["full_path", "path"]))
                            } label: { Image(systemName: "chevron.right") }
                        } else {
                            Button {
                                socket.download(entry)
                            } label: { Image(systemName: "arrow.down.circle") }
                                .disabled(socket.busyTransfer)
                        }
                        Menu {
                            Button("Rename", systemImage: "pencil") {
                                renameEntry = entry
                                renameText = nativeText(entry, ["name"])
                                showRename = true
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                deleteEntry = entry
                            }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                    .padding(.vertical, 4)
                }
                if visibleFiles.isEmpty && socket.connected {
                    Text("No files found in this folder.")
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
        }
    }
}
