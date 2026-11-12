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
    @State private var useSystemKeyboard = true
    @AppStorage("h5c.rmm.keyboard.preference") private var keyboardPreference = "ios"
    @AppStorage("h5c.rmm.keyboard.autoFocus") private var automaticKeyboardEnabled = true
    @State private var keyboardWasAutoOpened = false
    @State private var manuallyDismissedCurrentFocus = false
    @State private var showCAD = false
    @State private var showClose = false
    @State private var scale: CGFloat = 1
    @State private var panOffset: CGSize = .zero
    @State private var panMode = true
    @State private var viewportSize: CGSize = .zero
    @State private var lastFocalPoint: CGPoint?
    @State private var didStart = false
    @State private var showDiagnostics = false
    @State private var isClosing = false

    // Keep the iPhone keyboard available if WebRTC briefly reports ICE
    // disconnected while an active remote video track remains visible.
    private var canTypeOnRemote: Bool { engine.connected || engine.hasVideo }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                Color.black
                GeometryReader { geometry in
                    ZStack {
                        NativeVideoCanvas(renderer: engine.renderer)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .scaleEffect(scale)
                            .offset(panOffset)

                        if engine.hasVideo {
                            NativeRemoteTouchSurface(
                                zoom: $scale,
                                pan: $panOffset,
                                panMode: $panMode,
                                videoSize: CGSize(width: engine.videoWidth, height: engine.videoHeight),
                                active: engine.connected || engine.hasVideo,
                                onTouch: { point in lastFocalPoint = point },
                                onDesktopClick: { x, y in
                                    // Common Windows bottom-taskbar search positions:
                                    // Windows 10 near Start and centred Windows 11.
                                    // Only an actual remote left-click triggers this;
                                    // pinching, panning and ordinary editing do not.
                                    if y > 0.94 &&
                                        ((x > 0.055 && x < 0.235) ||
                                         (x > 0.465 && x < 0.555)) {
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                                            if canTypeOnRemote && !isClosing { openKeyboard() }
                                        }
                                    }
                                },
                                send: { kind, values in engine.sendInput(kind, values: values) }
                            )
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .zIndex(1)
                        }
                    }
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .clipped()
                    .onAppear { viewportSize = geometry.size }
                    .onChange(of: geometry.size) { size in
                        viewportSize = size
                        panOffset = limitPan(panOffset, at: scale)
                    }
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

                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            nativeControls
            // Keyboard is independent of WebRTC codec/capture negotiation.
            // The full UK Windows laptop layout is the default; users can
            // switch back to the proven native iPhone typing field if needed.
            if showText && canTypeOnRemote {
                if useSystemKeyboard {
                    VStack(spacing: 8) {
                        HStack(spacing: 8) {
                            Button("Laptop") { setKeyboardPreference("laptop") }
                                .buttonStyle(.bordered)
                                .accessibilityLabel("Return to Windows laptop keyboard")
                            NativeRemoteKeyboardInput(
                                active: showText && canTypeOnRemote && useSystemKeyboard,
                                kind: engine.remoteFocusKind,
                                onInsert: { engine.typeText($0) },
                                onDelete: { engine.keyPress("Backspace") },
                                onReturn: { engine.keyPress("Enter") }
                            )
                            .frame(height: 43)
                            Button { hideKeyboard() } label: {
                                Image(systemName: "keyboard.chevron.compact.down")
                                    .font(.system(size: 17))
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Hide iPhone keyboard")
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 7) {
                                extraKey("Win") { engine.keyPress("MetaLeft") }
                                extraKey("Esc") { engine.keyPress("Escape") }
                                extraKey("Tab") { engine.keyPress("Tab") }
                                extraKey("⇧Tab") { engine.keyChord(["ShiftLeft", "Tab"]) }
                                extraKey("⌫") { engine.keyPress("Backspace") }
                                extraKey("Del") { engine.keyPress("Delete") }
                                extraKey("←") { engine.keyPress("ArrowLeft") }
                                extraKey("↑") { engine.keyPress("ArrowUp") }
                                extraKey("↓") { engine.keyPress("ArrowDown") }
                                extraKey("→") { engine.keyPress("ArrowRight") }
                                extraKey("Home") { engine.keyPress("Home") }
                                extraKey("End") { engine.keyPress("End") }
                                extraKey("Ctrl+A") { engine.keyChord(["ControlLeft", "KeyA"]) }
                                extraKey("Ctrl+C") { engine.keyChord(["ControlLeft", "KeyC"]) }
                                extraKey("Ctrl+V") { engine.keyChord(["ControlLeft", "KeyV"]) }
                                extraKey("Ctrl+X") { engine.keyChord(["ControlLeft", "KeyX"]) }
                                extraKey("Alt+Tab") { engine.shortcut("alt_tab") }
                            }
                            .padding(.horizontal, 2)
                        }
                        .buttonStyle(.bordered)
                        .font(.caption)
                    }
                    .padding(9)
                    .background(Color(uiColor: .secondarySystemBackground))
                } else {
                    NativeWindowsLaptopKeyboard(
                        onText: { engine.typeText($0) },
                        onKey: { engine.keyPress($0) },
                        onChord: { engine.keyChord($0) },
                        onUseSystemKeyboard: { setKeyboardPreference("ios") },
                        onHide: { hideKeyboard() }
                    )
                }
            }
        }
        .background(Color.black)
        .task {
            guard !didStart else { return }
            didStart = true
            useSystemKeyboard = keyboardPreference != "laptop"
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
            if !connected && !engine.hasVideo { hideKeyboard(manual: false) }
            if connected, let id = launch?.sessionId {
                Task { await RemoteSessionActivity.shared.update(sessionId: id, state: "Connected") }
            }
        }
        .onChange(of: engine.remoteFocusRevision) { _ in
            guard automaticKeyboardEnabled && !isClosing else { return }
            if engine.remoteFocusEditable == true {
                if canTypeOnRemote && !manuallyDismissedCurrentFocus && !showText {
                    openKeyboard(automatically: true)
                }
            } else if engine.remoteFocusEditable == false {
                manuallyDismissedCurrentFocus = false
                // Only close keyboards that were opened automatically.
                // Manually opened native or laptop keyboards remain visible.
                if keyboardWasAutoOpened { hideKeyboard(manual: false) }
            }
        }
        .onChange(of: engine.hasVideo) { playing in
            if playing && automaticKeyboardEnabled &&
               engine.remoteFocusEditable == true && !showText &&
               !manuallyDismissedCurrentFocus {
                openKeyboard(automatically: true)
            }
        }
        // A temporary SwiftUI disappearance is not a remote-session close.
        // Only the explicit Disconnect action terminates the server session.
        // If this view is truly destroyed, the transport deinit closes its socket.
        .sheet(isPresented: $showDiagnostics) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 7) {
                    Label("Native touch events sent: \(engine.touchEventsSent)", systemImage: "hand.tap")
                        .font(.subheadline)
                    Text("Input transport: \(engine.controlPath)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Windows text focus: \(engine.remoteFocusEditable == nil ? "Not reported" : (engine.remoteFocusEditable == true ? engine.remoteFocusKind : "Not editable"))")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Automatic iPhone keyboard for Windows text fields", isOn: $automaticKeyboardEnabled)
                        .font(.caption)
                    Text("ICE candidates: local \(engine.localIceCandidates), remote \(engine.remoteIceCandidates)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("TURN relay candidates: local \(engine.localRelayCandidates), remote \(engine.remoteRelayCandidates)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Authenticated TURN: \(engine.availableTurnServers) available (\(engine.offeredTurnServers) signalled)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Tap, double-tap, long-press to right-click, drag and two-finger scroll are enabled.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                List(Array(engine.recentEvents.enumerated().reversed()), id: \.offset) { row in
                    Text(row.element).font(.subheadline)
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
            Button { changeZoom(to: scale / 1.35) } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            Button { changeZoom(to: scale * 1.35) } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            Button {
                if showText { hideKeyboard() } else { openKeyboard() }
            } label: {
                Image(systemName: "keyboard")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 46, height: 46)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canTypeOnRemote)
            .accessibilityLabel(showText ? "Hide iPhone keyboard" : "Open iPhone keyboard")
            .accessibilityHint("Available even when the remote desktop is zoomed or panned.")
            .zIndex(10)
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
                // Fixed SwiftUI controls sit outside the zoomed remote canvas.
                control("Keyboard", "keyboard") {
                    if showText { hideKeyboard() } else { openKeyboard() }
                }
                .disabled(!canTypeOnRemote)
                control("Search", "magnifyingglass") {
                    guard canTypeOnRemote else { return }
                    // Windows+S focuses the Windows Search box regardless
                    // of display resolution, taskbar alignment or zoom.
                    engine.keyChord(["MetaLeft", "KeyS"])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.20) {
                        if canTypeOnRemote && !isClosing { openKeyboard() }
                    }
                }
                .disabled(!canTypeOnRemote)
                control("Fit", "arrow.up.left.and.arrow.down.right") {
                    scale = 1
                    panOffset = .zero
                    panMode = true
                }
                control(panMode ? "Pan" : "Drag", panMode ? "hand.draw" : "hand.point.up.left") {
                    panMode.toggle()
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

    private func limitPan(_ proposed: CGSize, at zoom: CGFloat) -> CGSize {
        guard viewportSize.width > 0, viewportSize.height > 0,
              engine.videoWidth > 0, engine.videoHeight > 0 else { return .zero }
        let fit = min(viewportSize.width / engine.videoWidth,
                      viewportSize.height / engine.videoHeight)
        let width = engine.videoWidth * fit
        let height = engine.videoHeight * fit
        let marginX = max(0, (width * zoom - viewportSize.width) / 2)
        let marginY = max(0, (height * zoom - viewportSize.height) / 2)
        return CGSize(
            width: min(marginX, max(-marginX, proposed.width)),
            height: min(marginY, max(-marginY, proposed.height))
        )
    }

    private func changeZoom(to desired: CGFloat) {
        let next = min(6, max(1, desired))
        guard viewportSize.width > 0, viewportSize.height > 0 else {
            scale = next
            return
        }
        // Preserve the desktop point last touched when using +/-.
        // The pinch handler independently anchors at the fingers' midpoint.
        let c = CGPoint(x: viewportSize.width / 2, y: viewportSize.height / 2)
        let focus = lastFocalPoint ?? c
        let before = max(1, scale)
        let anchor = CGPoint(
            x: c.x + (focus.x - c.x - panOffset.width) / before,
            y: c.y + (focus.y - c.y - panOffset.height) / before
        )
        let newPan = CGSize(
            width: focus.x - c.x - next * (anchor.x - c.x),
            height: focus.y - c.y - next * (anchor.y - c.y)
        )
        scale = next
        panOffset = next <= 1.02 ? .zero : limitPan(newPan, at: next)
        if next > 1.02 { panMode = true }
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

    private func extraKey(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 12, weight: .medium))
                .frame(minWidth: 36, minHeight: 34)
        }
        .accessibilityLabel("Remote Windows " + label)
    }

    private func setKeyboardPreference(_ newValue: String) {
        let native = newValue != "laptop"
        keyboardPreference = native ? "ios" : "laptop"
        useSystemKeyboard = native
        // Switching styles keeps the remote Windows field focused.
        showText = true
    }

    private func openKeyboard(automatically: Bool = false) {
        guard canTypeOnRemote else { return }
        if automatically && manuallyDismissedCurrentFocus { return }
        useSystemKeyboard = keyboardPreference != "laptop"
        showText = true
        keyboardWasAutoOpened = automatically
        if !automatically { manuallyDismissedCurrentFocus = false }
    }

    private func hideKeyboard(manual: Bool = true) {
        if manual && engine.remoteFocusEditable == true {
            // Do not instantly reopen from repeated focus updates.
            manuallyDismissedCurrentFocus = true
        }
        showText = false
        keyboardWasAutoOpened = false
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
