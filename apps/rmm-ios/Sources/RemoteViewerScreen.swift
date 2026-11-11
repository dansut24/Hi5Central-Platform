import SwiftUI
import WebKit
import UIKit

// Native controls forward only known UI actions to the existing secured WebRTC
// viewer. No session tokens, credentials, or signal payloads cross this bridge.
@MainActor
final class ViewerStore: ObservableObject {
    let webView: WKWebView
    @Published private(set) var connected = false
    @Published var message: String?

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addUserScript(
            WKUserScript(source: NativeWebScripts.viewer,
                         injectionTime: .atDocumentEnd,
                         forMainFrameOnly: true)
        )

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
    }

    // These IDs are from the existing Hi5Central Viewer, not an arbitrary
    // caller-supplied string. Disabled buttons keep their original guards.
    enum Control: String {
        case files = "btn-files"
        case chat = "btn-chat"
        case audio = "btn-audio"
        case lockInput = "btn-block-input"
        case desktop = "btn-console"
        case backstage = "btn-backstage"
        case windows = "btn-start-menu"
        case security = "btn-cad"
        case monitors = "btn-monitor"
        case diagnostics = "btn-settings"
        case zoomIn = "mobile-zoom-in"
        case zoomOut = "mobile-zoom-out"
        case zoomFit = "mobile-zoom-fit"
        case trackpad = "mobile-input-mode"
        case pan = "mobile-pan-mode"
        case precision = "mobile-precision-mode"
        case remoteKeyboard = "btn-keyboard"
        case clipboardCopy = "mobile-clipboard-copy"
        case clipboardPaste = "mobile-clipboard-paste"
    }

    func activate(_ control: Control) {
        let js = "document.getElementById('\(control.rawValue)')?.click();"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func refreshConnection() {
        webView.evaluateJavaScript("window.hi5RemoteViewer?.isConnected?.() === true") { result, _ in
            DispatchQueue.main.async {
                self.connected = (result as? Bool) == true
            }
        }
    }

    func type(_ value: String) {
        guard !value.isEmpty else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let stringLiteral = String(data: data, encoding: .utf8) else { return }
        // The existing sendMobileTextEntry function is wired to this button.
        let script = """
          (() => {
            const input = document.getElementById('mobile-text-input');
            const send = document.getElementById('mobile-text-send');
            if (!input || !send || input.disabled || send.disabled) return false;
            input.value = \(stringLiteral);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            send.click();
            return true;
          })();
        """
        webView.evaluateJavaScript(script) { value, _ in
            DispatchQueue.main.async {
                if (value as? Bool) != true {
                    self.message = "Connect to the remote device before sending text."
                } else {
                    self.message = nil
                }
            }
        }
    }

    func disconnect(completion: @escaping () -> Void) {
        // The viewer handles agent cleanup and backend session termination.
        webView.evaluateJavaScript("window.hi5RemoteViewer?.disconnect?.();") { _, _ in
            DispatchQueue.main.async { completion() }
        }
    }
}

private struct ViewerWebView: UIViewRepresentable {
    let webView: WKWebView
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

struct RemoteViewerScreen: View {
    let target: ViewerLaunch
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = ViewerStore()
    @State private var closing = false
    @State private var showText = false
    @State private var typedText = ""
    @State private var showCADConfirmation = false
    @State private var showBlockConfirmation = false
    @FocusState private var typingFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.white.opacity(0.10))
            ViewerWebView(webView: store.webView, url: target.url)
                .background(Color.black)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            nativeToolbar
            if showText { textEntry }
        }
        .background(Color.black)
        .alert("Send Ctrl+Alt+Del?", isPresented: $showCADConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Send") { store.activate(.security) }
        } message: {
            Text("Send the secure attention shortcut to the remote computer.")
        }
        .alert("Block local input?", isPresented: $showBlockConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Continue") { store.activate(.lockInput) }
        } message: {
            Text("Only use this when authorised to prevent input at the remote computer.")
        }
        .task {
            while !Task.isCancelled {
                store.refreshConnection()
                try? await Task.sleep(nanoseconds: 1_200_000_000)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "display").foregroundStyle(.cyan)
            VStack(alignment: .leading, spacing: 2) {
                Text("Remote session").font(.subheadline.bold())
                HStack(spacing: 5) {
                    Circle().fill(store.connected ? Color.green : Color.orange)
                        .frame(width: 6, height: 6)
                    Text(store.connected ? "Connected" : "Connecting")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button { store.activate(.zoomOut) } label: {
                Image(systemName: "minus.magnifyingglass")
            }.accessibilityLabel("Zoom out")
            Button { store.activate(.zoomIn) } label: {
                Image(systemName: "plus.magnifyingglass")
            }.accessibilityLabel("Zoom in")
            Button {
                showText.toggle()
                if showText { typingFocused = true }
            } label: {
                Image(systemName: "keyboard")
            }.accessibilityLabel("iPhone keyboard")
            Button(role: .destructive) {
                guard !closing else { return }
                closing = true
                store.disconnect { dismiss() }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.bordered)
            .disabled(closing)
            .accessibilityLabel("Disconnect and close")
        }
        .font(.system(size: 17))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .foregroundStyle(.primary)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private var nativeToolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                tool("Fit", "arrow.up.left.and.arrow.down.right", .zoomFit)
                tool("Files", "folder", .files)
                tool("Chat", "bubble.left.and.bubble.right", .chat)
                tool("Audio", "speaker.wave.2", .audio)
                tool("Windows", "square.grid.2x2", .windows)
                tool("Screens", "rectangle.on.rectangle", .monitors)
                tool("Trackpad", "hand.point.up.left", .trackpad)
                tool("Pan", "hand.draw", .pan)
                tool("Precision", "scope", .precision)
                Button { showCADConfirmation = true } label: {
                    nativeIcon("Ctrl+Alt+Del", "keyboard.badge.ellipsis")
                }.buttonStyle(.plain)
                Button { showBlockConfirmation = true } label: {
                    nativeIcon("Block input", "lock.shield")
                }.buttonStyle(.plain)
                tool("Copy", "doc.on.doc", .clipboardCopy)
                tool("Settings", "gearshape", .diagnostics)
                tool("Backstage", "rectangle.portrait.on.rectangle.portrait", .backstage)
                tool("Desktop", "desktopcomputer", .desktop)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
        }
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private func tool(_ label: String, _ symbol: String, _ control: ViewerStore.Control) -> some View {
        Button {
            store.activate(control)
        } label: {
            nativeIcon(label, symbol)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func nativeIcon(_ label: String, _ symbol: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .frame(width: 48, height: 24)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(.primary)
        .frame(width: 74, height: 46)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
    }

    private var textEntry: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                TextField("Type on remote computer", text: $typedText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($typingFocused)
                    .submitLabel(.send)
                    .onSubmit(sendText)
                    .padding(11)
                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                Button("Send", action: sendText)
                    .buttonStyle(.borderedProminent)
                    .disabled(typedText.isEmpty)
                Button {
                    if let text = UIPasteboard.general.string {
                        store.type(text)
                    }
                } label: {
                    Image(systemName: "doc.on.clipboard")
                }
                .accessibilityLabel("Paste text from iPhone")
            }
            if let message = store.message {
                Text(message).font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private func sendText() {
        store.type(typedText)
        typedText = ""
        typingFocused = true
    }
}
