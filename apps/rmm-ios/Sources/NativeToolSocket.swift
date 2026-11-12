import Foundation
import SwiftUI

/// Dedicated short-lived live-tool transport. This is separate from the
/// working native remote viewer / codec and relies on the existing RMM
/// session-scoped WebSocket token and tenant permissions.
@MainActor
final class NativeToolSocket: ObservableObject {
    @Published private(set) var status = "Connecting…"
    @Published private(set) var connected = false
    @Published private(set) var terminalOutput = ""
    @Published private(set) var files: [[String: Any]] = []
    @Published private(set) var drives: [[String: Any]] = []
    @Published private(set) var path = ""
    @Published private(set) var parent = ""
    @Published private(set) var downloadedURL: URL?
    @Published private(set) var downloadedName = ""
    @Published private(set) var busyTransfer = false

    private var tool = ""
    private var socket: URLSessionWebSocketTask?
    private var active = false
    private var initialPath = ""
    private var downloadId = ""
    private var downloadBytes = Data()
    private let maxDownloadBytes = 32 * 1024 * 1024
    private lazy var bridge = NativeToolSocketDelegate(
        onOpen: { [weak self] in
            Task { @MainActor [weak self] in self?.didOpen() }
        },
        onClose: { [weak self] code in
            Task { @MainActor [weak self] in
                guard let self, self.active else { return }
                self.connected = false
                self.status = "Connection closed (\(code))"
            }
        }
    )
    private lazy var session = URLSession(configuration: .default,
                                          delegate: bridge,
                                          delegateQueue: nil)

    func showError(_ text: String) {
        status = text
        connected = false
    }

    func connect(_ access: RMMClient.LiveToolSession,
                 initialPath: String = "") {
        disconnect()
        tool = access.tool
        self.initialPath = initialPath
        self.path = initialPath
        status = "Connecting…"
        active = true
        let ws = session.webSocketTask(with: access.websocketURL)
        socket = ws
        ws.resume()
        Task { [weak self] in await self?.readLoop(ws) }
    }

    private func didOpen() {
        guard active else { return }
        connected = true
        status = "Connected"
        if tool == "files" {
            send(["type": "files_list", "path": initialPath])
        }
    }

    private func readLoop(_ ws: URLSessionWebSocketTask) async {
        while active && socket === ws {
            do {
                let response = try await ws.receive()
                let payload: Data
                switch response {
                case .string(let text): payload = Data(text.utf8)
                case .data(let data): payload = data
                @unknown default: continue
                }
                if let message = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                    handle(message)
                }
            } catch {
                if active && socket === ws {
                    connected = false
                    status = "Live tool disconnected: \(error.localizedDescription)"
                }
                break
            }
        }
    }

    private func handle(_ message: [String: Any]) {
        switch nativeString(message["type"]) {
        case "terminal_output":
            let text = nativeString(message["data"])
            terminalOutput += text
            // Constrain the in-memory output, never store shell transcripts
            // in app preferences, local logs or crash diagnostics.
            if terminalOutput.count > 160_000 {
                terminalOutput = String(terminalOutput.suffix(130_000))
            }
        case "terminal_error", "files_error":
            status = nativeText(message, ["error"], fallback: "Tool error")
        case "terminal_closed":
            status = "Terminal closed"
            connected = false
        case "files_result":
            let result = nativeDict(message["result"])
            path = nativeText(message, ["path"],
                              fallback: nativeText(result, ["path"], fallback: initialPath))
            parent = nativeText(message, ["parent"],
                                fallback: nativeString(result["parent"]))
            files = nativeRows(message["entries"]).isEmpty
                ? nativeRows(result["entries"]) : nativeRows(message["entries"])
            drives = nativeRows(message["drives"]).isEmpty
                ? nativeRows(result["drives"]) : nativeRows(message["drives"])
            status = "Connected · \(files.count) items"
        case "files_action_result", "files_upload_result":
            busyTransfer = false
            if message["success"] as? Bool == false {
                status = nativeText(message, ["error"], fallback: "File action failed")
            } else {
                status = nativeText(message, ["message"], fallback: "Completed")
                let refreshed = nativeText(message, ["refreshPath", "refresh_path"], fallback: path)
                send(["type": "files_list", "path": refreshed])
            }
        case "files_download_start":
            let size = (message["size_bytes"] as? NSNumber)?.intValue
                ?? (message["size"] as? NSNumber)?.intValue ?? 0
            guard size <= maxDownloadBytes else {
                let id = nativeText(message, ["transferId", "transfer_id"])
                send(["type": "files_download_cancel", "transferId": id])
                status = "File exceeds the 32 MB iPhone download limit."
                busyTransfer = false
                return
            }
            downloadId = nativeText(message, ["transferId", "transfer_id"])
            downloadedName = nativeText(message, ["filename"], fallback: "download.bin")
            downloadBytes = Data()
            busyTransfer = true
            status = "Downloading \(downloadedName)…"
        case "files_download_chunk":
            let id = nativeText(message, ["transferId", "transfer_id"])
            guard id == downloadId, let chunk = Data(base64Encoded: nativeString(message["data"])) else { return }
            if downloadBytes.count + chunk.count > maxDownloadBytes {
                send(["type": "files_download_cancel", "transferId": id])
                downloadBytes.removeAll()
                busyTransfer = false
                status = "File exceeds the 32 MB iPhone download limit."
            } else {
                downloadBytes.append(chunk)
            }
        case "files_download_complete":
            guard nativeText(message, ["transferId", "transfer_id"]) == downloadId else { return }
            let name = URL(fileURLWithPath: downloadedName).lastPathComponent
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + "-" + name)
            do {
                try downloadBytes.write(to: destination, options: [.atomic])
                downloadedURL = destination
                status = "Downloaded \(name). Use Share to save it."
            } catch {
                status = "Unable to save the download: \(error.localizedDescription)"
            }
            busyTransfer = false
            downloadBytes.removeAll()
        case "files_download_error":
            busyTransfer = false
            downloadBytes.removeAll()
            status = nativeText(message, ["error"], fallback: "Download failed")
        default:
            break
        }
    }

    func send(_ message: [String: Any]) {
        guard active, let ws = socket,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        Task { [weak self] in
            do { try await ws.send(.string(text)) }
            catch {
                self?.status = "Unable to send tool request: \(error.localizedDescription)"
            }
        }
    }

    func run(_ command: String) {
        guard connected, tool == "terminal", !command.isEmpty else { return }
        send(["type": "terminal_input", "data": command + "\r"])
    }

    func list(_ location: String) {
        guard connected, tool == "files" else { return }
        status = "Loading \(location)…"
        send(["type": "files_list", "path": location])
    }

    func download(_ entry: [String: Any]) {
        guard connected, !busyTransfer else { return }
        busyTransfer = true
        let identifier = UUID().uuidString
        send(["type": "files_download_request", "transferId": identifier,
              "path": nativeText(entry, ["full_path", "path"])])
    }

    func createFolder(_ name: String) {
        guard !name.isEmpty else { return }
        send(["type": "files_mkdir_request", "currentPath": path, "name": name])
    }

    func rename(_ entry: [String: Any], to name: String) {
        guard !name.isEmpty else { return }
        send(["type": "files_rename_request",
              "path": nativeText(entry, ["full_path", "path"]),
              "currentPath": path, "name": name])
    }

    func delete(_ entry: [String: Any]) {
        send(["type": "files_delete_request",
              "path": nativeText(entry, ["full_path", "path"]),
              "currentPath": path])
    }

    func upload(_ url: URL) async {
        guard connected, !busyTransfer else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 16 * 1024 * 1024 else {
                status = "Uploads are limited to 16 MB in this iPhone build."
                return
            }
            busyTransfer = true
            status = "Uploading \(url.lastPathComponent)…"
            let id = UUID().uuidString
            send(["type": "files_upload_start", "transferId": id, "directory": path,
                  "filename": url.lastPathComponent, "size_bytes": data.count])
            let chunkSize = 32768
            var index = 0
            for offset in stride(from: 0, to: data.count, by: chunkSize) {
                let part = data.subdata(in: offset..<min(offset+chunkSize, data.count))
                send(["type": "files_upload_chunk", "transferId": id, "index": index,
                      "data": part.base64EncodedString()])
                index += 1
            }
            send(["type": "files_upload_complete", "transferId": id, "directory": path,
                  "filename": url.lastPathComponent, "size_bytes": data.count])
        } catch {
            busyTransfer = false
            status = "Unable to read file: \(error.localizedDescription)"
        }
    }

    func disconnect() {
        active = false
        connected = false
        if let ws = socket {
            if tool == "terminal" {
                if let data = try? JSONSerialization.data(withJSONObject: ["type": "terminal_stop"]),
                   let text = String(data: data, encoding: .utf8) {
                    Task { try? await ws.send(.string(text)) }
                }
            }
            ws.cancel(with: .normalClosure, reason: nil)
        }
        socket = nil
        downloadBytes.removeAll()
        busyTransfer = false
    }
}

private final class NativeToolSocketDelegate: NSObject, URLSessionWebSocketDelegate {
    let onOpen: () -> Void
    let onClose: (Int) -> Void

    init(onOpen: @escaping () -> Void, onClose: @escaping (Int) -> Void) {
        self.onOpen = onOpen
        self.onClose = onClose
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        onClose(closeCode.rawValue)
    }
}
