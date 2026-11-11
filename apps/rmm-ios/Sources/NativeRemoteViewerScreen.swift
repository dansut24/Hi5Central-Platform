import SwiftUI
import WebRTC

private let nativeBlue = Color(red: 0.18, green: 0.48, blue: 0.96)

private struct NativeVideoCanvas: UIViewRepresentable {
    let renderer: RTCMTLVideoView

    func makeUIView(context: Context) -> RTCMTLVideoView {
        renderer.videoContentMode = .scaleAspectFit
        renderer.backgroundColor = .black
        return renderer
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {}
}

struct NativeRemoteViewerScreen: View {
    let target: ViewerLaunch
    @EnvironmentObject private var client: RMMClient
    @EnvironmentObject private var state: RMMState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var engine = NativeRemoteEngine()
    @State private var launch: NativeViewerParameters?
    @State private var showChat = false
    @State private var showFiles = false
    @State private var showText = false
    @State private var message = ""
    @State private var showCAD = false
    @State private var showClose = false
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var didStart = false
    @State private var showDiagnostics = false
    @State private var isClosing = false

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                Color.black
                GeometryReader { geometry in
                    NativeVideoCanvas(renderer: engine.renderer)
                        .scaleEffect(scale)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .simultaneousGesture(SpatialTapGesture().onEnded { value in
                            guard engine.connected else { return }
                            let videoSize = CGSize(width: engine.videoWidth, height: engine.videoHeight)
                            let viewport = geometry.size
                            guard videoSize.width > 0, videoSize.height > 0,
                                  viewport.width > 0, viewport.height > 0 else { return }
                            let ratio = min(viewport.width / videoSize.width,
                                            viewport.height / videoSize.height)
                            let rendered = CGSize(width: videoSize.width * ratio,
                                                  height: videoSize.height * ratio)
                            let left = (viewport.width - rendered.width) / 2
                            let top = (viewport.height - rendered.height) / 2
                            let x = (value.location.x - left) / rendered.width
                            let y = (value.location.y - top) / rendered.height
                            guard (0...1).contains(x), (0...1).contains(y) else { return }
                            engine.tap(x: x, y: y)
                        })
                        .simultaneousGesture(MagnificationGesture()
                            .onChanged { value in scale = min(4, max(1, lastScale * value)) }
                            .onEnded { _ in lastScale = scale })
                }
                if !engine.hasVideo {
                    VStack(spacing: 14) {
                        Image(systemName: "display")
                            .font(.system(size: 43)).foregroundStyle(nativeBlue)
                        Text(engine.status).font(.headline)
                            .multilineTextAlignment(.center)
                        if !engine.isEnded && !isClosing { ProgressView().tint(.white) }
                        Text("Native iOS WebRTC")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Connection details") {
                            showDiagnostics = true
                        }
                        .font(.subheadline)
                        .buttonStyle(.bordered)
                        .allowsHitTesting(true)
                    }
                    .padding(20)
                    .foregroundStyle(.white)
                    .allowsHitTesting(false)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            nativeControls
            if showText {
                HStack(spacing: 8) {
                    TextField("Type on remote computer", text: $message)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(11)
                        .background(Color(uiColor: .tertiarySystemFill),
                                    in: RoundedRectangle(cornerRadius: 10))
                        .onSubmit(sendText)
                    Button("Send", action: sendText)
                        .buttonStyle(.borderedProminent)
                        .disabled(message.isEmpty || !engine.connected)
                }
                .padding(10)
                .background(Color(uiColor: .secondarySystemBackground))
            }
        }
        .background(Color.black)
        .task {
            guard !didStart else { return }
            didStart = true
            guard let params = NativeViewerParameters(url: target.url) else {
                engine.showError("Invalid session launch. Close and start a new session from Devices.")
                return
            }
            launch = params
            engine.start(params)
            await RemoteSessionActivity.shared.start(
                sessionId: params.sessionId,
                deviceName: "Remote desktop",
                state: "Connecting"
            )
        }
        .onChange(of: engine.connected) { connected in
            if connected, let id = launch?.sessionId {
                Task { await RemoteSessionActivity.shared.update(sessionId: id, state: "Connected") }
            }
        }
        .onDisappear {
            // SwiftUI can temporarily remove a view while presenting sheets or
            // changing app phase. Do not kill the server session unless the
            // technician explicitly confirms Disconnection.
            if isClosing || state.viewer?.id != target.id {
                engine.close(reason: "Viewer closed")
                if let id = launch?.sessionId {
                    Task { await RemoteSessionActivity.shared.end(sessionId: id) }
                }
            }
        }
        .sheet(isPresented: $showDiagnostics) {
            NavigationStack {
                List(engine.recentEvents.reversed(), id: \.self) { event in
                    Text(event).font(.subheadline)
                }
                .navigationTitle("Connection details")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showDiagnostics = false } } }
            }
        }
        .sheet(isPresented: $showChat) {
            NativeRemoteChatSheet(engine: engine)
        }
        .sheet(isPresented: $showFiles) {
            NativeRemoteFilesSheet(engine: engine)
                .onAppear { engine.browseFiles("/") }
        }
        .confirmationDialog("Disconnect from this computer?", isPresented: $showClose,
                            titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) {
                isClosing = true
                engine.close(reason: "Disconnected by technician")
                if let id = launch?.sessionId {
                    Task {
                        try? await client.terminateRemoteSession(id: id)
                        await RemoteSessionActivity.shared.end(sessionId: id)
                    }
                }
                dismiss()
            }
        }
        .confirmationDialog("Send Ctrl+Alt+Del?", isPresented: $showCAD,
                            titleVisibility: .visible) {
            Button("Send Ctrl+Alt+Del") { engine.shortcut("ctrl_alt_del") }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "desktopcomputer").foregroundStyle(nativeBlue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Remote session").font(.subheadline.bold())
                Text(engine.status).font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { scale = max(1, scale - 0.25); lastScale = scale } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            Button { scale = min(4, scale + 0.25); lastScale = scale } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            Button { showText.toggle() } label: {
                Image(systemName: "keyboard")
            }
            Button { showClose = true } label: {
                Image(systemName: "xmark").font(.subheadline.bold())
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("End session")
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private var nativeControls: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                control("Fit", "arrow.up.left.and.arrow.down.right") {
                    scale = 1; lastScale = 1
                }
                control("Chat", "bubble.left.and.bubble.right") { showChat = true }
                control("Files", "folder") { showFiles = true }
                control("Windows", "square.grid.2x2") { engine.shortcut("start_menu") }
                control("Ctrl Alt Del", "keyboard.badge.ellipsis") { showCAD = true }
                control("Copy", "doc.on.doc") { engine.shortcut("copy") }
                control("Paste", "doc.on.clipboard") {
                    if let text = UIPasteboard.general.string { engine.typeText(text) }
                }
            }
            .padding(9)
        }
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private func control(_ label: String, _ icon: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            VStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 21))
                Text(label).font(.system(size: 10, weight: .medium))
            }
            .frame(width: 82, height: 48)
            .foregroundStyle(.primary)
            .background(Color(uiColor: .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 11))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func sendText() {
        engine.typeText(message)
        message = ""
    }
}

private struct NativeRemoteChatSheet: View {
    @ObservedObject var engine: NativeRemoteEngine
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { scroll in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if engine.chat.isEmpty {
                                Text("No messages yet.")
                                    .font(.subheadline).foregroundStyle(.secondary)
                                    .padding(.top, 30)
                            }
                            ForEach(engine.chat) { item in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.author).font(.caption.bold())
                                        .foregroundStyle(nativeBlue)
                                    Text(item.text).font(.subheadline).textSelection(.enabled)
                                }
                                .padding(13)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(uiColor: .secondarySystemBackground),
                                            in: RoundedRectangle(cornerRadius: 13))
                                .id(item.id)
                            }
                        }
                        .padding(16)
                    }
                    .onChange(of: engine.chat.count) { _ in
                        if let id = engine.chat.last?.id {
                            withAnimation { scroll.scrollTo(id, anchor: .bottom) }
                        }
                    }
                }
                HStack {
                    TextField("Message remote user", text: $draft)
                        .padding(11)
                        .background(Color(uiColor: .tertiarySystemFill),
                                    in: RoundedRectangle(cornerRadius: 12))
                        .onSubmit(send)
                    Button("Send", action: send)
                        .buttonStyle(.borderedProminent)
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                  !engine.connected)
                }
                .padding(10)
            }
            .navigationTitle("Remote chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }

    private func send() {
        engine.sendChat(draft)
        draft = ""
    }
}

private struct NativeRemoteFilesSheet: View {
    @ObservedObject var engine: NativeRemoteEngine
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(engine.filePath)
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    if engine.filePath != "/" {
                        Button {
                            let parent = (engine.filePath as NSString).deletingLastPathComponent
                            engine.browseFiles(parent.isEmpty ? "/" : parent)
                        } label: {
                            Label("Parent folder", systemImage: "arrow.up.left")
                        }
                    }
                }
                if let status = engine.fileStatus {
                    Section { Text(status).font(.footnote).foregroundStyle(.secondary) }
                }
                Section("Remote files") {
                    if engine.files.isEmpty {
                        Text("No files available or still loading")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(engine.files) { item in
                        Button {
                            if item.isDirectory { engine.browseFiles(item.path) }
                            else { engine.downloadFile(item.path) }
                        } label: {
                            Label(item.name, systemImage: item.isDirectory ? "folder.fill" : "doc")
                                .foregroundStyle(.primary)
                        }
                    }
                }
                if let url = engine.downloadedFile {
                    Section("Downloaded file") {
                        ShareLink(item: url) {
                            Label("Save or share downloaded file", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
            .navigationTitle("Remote files")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { engine.browseFiles(engine.filePath) } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
