import SwiftUI
import WebKit

// This is a second WKWebView, separate from the portal. A remote session
// stays in the app, while the portal retains its login cookies and page state.
final class ViewerStore: ObservableObject {
    let webView: WKWebView

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor.black
        webView.scrollView.backgroundColor = UIColor.black
        webView.scrollView.isScrollEnabled = false
    }

    func focusRemoteTextEntry() {
        // The existing HTML viewer already translates its mobile text field
        // into remote keyboard events. We only request focus; no credentials,
        // keystrokes or session tokens travel through the native bridge.
        webView.evaluateJavaScript("document.getElementById('mobile-text-input')?.focus();", completionHandler: nil)
    }

    func disconnect(completion: @escaping () -> Void) {
        // Prefer the Viewer's own disconnect button so it can terminate the
        // remote session through its existing protocol and clean up resources.
        webView.evaluateJavaScript("document.getElementById('btn-disconnect')?.click();") { _, _ in
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

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct RemoteViewerScreen: View {
    let target: ViewerLaunch
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = ViewerStore()
    @State private var closing = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "display")
                    .foregroundStyle(.cyan)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Remote session").font(.subheadline.bold())
                    Text("Hi5Central Viewer").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    store.focusRemoteTextEntry()
                } label: {
                    Label("Type", systemImage: "keyboard")
                }
                .buttonStyle(.bordered)
                Button(role: .destructive) {
                    guard !closing else { return }
                    closing = true
                    store.disconnect { dismiss() }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.bordered)
                .disabled(closing)
                .accessibilityLabel("Disconnect and close")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color(uiColor: UIColor.secondarySystemBackground))
            ViewerWebView(webView: store.webView, url: target.url)
                .background(Color.black)
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
    }
}
