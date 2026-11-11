import Foundation
import SwiftUI
import WebRTC

struct NativeViewerParameters {
    let sessionId: String
    let deviceId: String
    let token: String
    let websocket: URL
    let iceServers: [RTCIceServer]

    init?(url: URL) {
        guard url.scheme == "https",
              let host = url.host?.lowercased(),
              host.hasSuffix("-rmm.hi5central.com"),
              url.path.hasPrefix("/rmm-viewer/"),
              let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment,
              let components = URLComponents(string: "https://viewer.invalid/?" + fragment) else { return nil }
        let values = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") },
                                uniquingKeysWith: { first, _ in first })
        guard let session = values["session_id"], UUID(uuidString: session) != nil,
              let device = values["device_id"], UUID(uuidString: device) != nil,
              let auth = values["token"], auth.hasPrefix("h5v"), auth.count > 20,
              let signalling = values["wss_url"], var ws = URLComponents(string: signalling),
              ws.scheme == "wss", let server = ws.host?.lowercased(),
              server == "hi5central.com" || server.hasSuffix(".hi5central.com") else { return nil }
        // The viewer's short-lived launch token must remain in memory only.
        sessionId = session
        deviceId = device
        token = auth
        var q = ws.queryItems ?? []
        q.append(contentsOf: [
            URLQueryItem(name: "session_id", value: session),
            URLQueryItem(name: "device_id", value: device),
            URLQueryItem(name: "token", value: auth),
            URLQueryItem(name: "client", value: "browser")
        ])
        ws.queryItems = q
        guard let endpoint = ws.url else { return nil }
        websocket = endpoint

        var servers: [RTCIceServer] = []
        if let encoded = values["ice"] {
            let base64 = encoded.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            let padded = base64.padding(toLength: ((base64.count + 3) / 4) * 4,
                                        withPad: "=", startingAt: 0)
            if let bytes = Data(base64Encoded: padded),
               let parsed = try? JSONSerialization.jsonObject(with: bytes) as? [[String: Any]] {
                for entry in parsed {
                    let urls: [String]
                    if let array = entry["urls"] as? [String] { urls = array }
                    else if let single = entry["urls"] as? String { urls = [single] }
                    else { urls = [] }
                    let permitted = urls.filter { $0.hasPrefix("stun:") || $0.hasPrefix("turn:") || $0.hasPrefix("turns:") }
                    if permitted.isEmpty { continue }
                    servers.append(RTCIceServer(urlStrings: permitted,
                                                username: entry["username"] as? String ?? "",
                                                credential: entry["credential"] as? String ?? ""))
                }
            }
        }
        iceServers = servers
    }
}

struct NativeChatEntry: Identifiable {
    let id: String
    let author: String
    let text: String
    let sentAt: Date
}

struct NativeFileEntry: Identifiable {
    let name: String
    let path: String
    let isDirectory: Bool
    var id: String { path }
}

final class NativeRemoteEngine: NSObject, ObservableObject {
    @Published private(set) var status = "Preparing connection"
    @Published private(set) var recentEvents: [String] = []
    @Published private(set) var touchEventsSent = 0
    @Published private(set) var controlPath = "Waiting for input channel"
    @Published private(set) var localIceCandidates = 0
    @Published private(set) var remoteIceCandidates = 0
    @Published private(set) var localRelayCandidates = 0
    @Published private(set) var remoteRelayCandidates = 0
    @Published private(set) var isEnded = false
    @Published private(set) var connected = false
    @Published private(set) var hasVideo = false
    @Published private(set) var chat: [NativeChatEntry] = []
    @Published private(set) var files: [NativeFileEntry] = []
    @Published private(set) var filePath = "/"
    @Published private(set) var downloadedFile: URL?
    @Published private(set) var fileStatus: String?
    @Published private(set) var alertMessage: String?
    @Published private(set) var videoWidth: CGFloat = 0
    @Published private(set) var videoHeight: CGFloat = 0

    let renderer = RTCMTLVideoView(frame: .zero)
    private var params: NativeViewerParameters?
    private let factory = RTCPeerConnectionFactory()
    private var peer: RTCPeerConnection?
    private var videoTrack: RTCVideoTrack?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var inputChannel: RTCDataChannel?
    private var inputControlChannel: RTCDataChannel?
    private var inputMoveChannel: RTCDataChannel?
    private var socketReady = false
    private var serverIceServers: [RTCIceServer]?
    private var receivedOffer = false
    private var remoteSdpReady = false
    private var pendingCandidates: [RTCIceCandidate] = []
    private var intentionallyClosed = false
    private var opening = false
    private var downloads: [String: (fileURL: URL, size: Int)] = [:]

    func start(_ launch: NativeViewerParameters) {
        guard !opening else { return }
        opening = true
        intentionallyClosed = false
        receivedOffer = false
        serverIceServers = nil
        params = launch
        DispatchQueue.main.async {
            self.isEnded = false
            self.localIceCandidates = 0
            self.remoteIceCandidates = 0
            self.localRelayCandidates = 0
            self.remoteRelayCandidates = 0
        }
        event("Starting remote session")
        openSocket()
    }

    private func openSocket() {
        guard let params else { return }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let socket = session.webSocketTask(with: params.websocket)
        self.socket = socket
        socket.resume()
        socketReady = true
        receive()
    }

    private func receive() {
        socket?.receive { [weak self] result in
            guard let self, !self.intentionallyClosed else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message {
                    self.read(text)
                } else if case .data(let data) = message,
                          let text = String(data: data, encoding: .utf8) {
                    self.read(text)
                }
                self.receive()
            case .failure(let error):
                self.socketReady = false
                self.event("Signalling receive failed: \(error.localizedDescription)")
                self.statusOnMain("Signalling connection failed")
            }
        }
    }

    private func send(_ data: [String: Any]) {
        guard !intentionallyClosed, socketReady,
              let bytes = try? JSONSerialization.data(withJSONObject: data),
              let text = String(data: bytes, encoding: .utf8) else { return }
        socket?.send(.string(text)) { [weak self] error in
            if error != nil { self?.statusOnMain("Connection interrupted") }
        }
    }

    private func read(_ text: String) {
        guard let bytes = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = message["type"] as? String else { return }

        switch type {
        case "viewer_connected":
            event("Signalling authenticated")
        case "start_webrtc_sent":
            event("Requested WebRTC stream from device")
        case "webrtc_offer":
            guard let sdp = message["sdp"] as? String, !sdp.isEmpty else {
                event("Empty video offer received")
                return
            }
            event("Remote video offer received")
            createAnswer(sdp)
        case "ice_candidate":
            let sdp = message["candidate"] as? String ?? ""
            guard !sdp.isEmpty else { return }
            let mid = message["mid"] as? String ?? message["sdpMid"] as? String
            let index = (message["mline_index"] as? NSNumber)?.int32Value ??
                        (message["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
            let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: mid)
            let isRelay = sdp.contains(" typ relay")
            DispatchQueue.main.async {
                self.remoteIceCandidates += 1
                if isRelay { self.remoteRelayCandidates += 1 }
            }
            if remoteSdpReady { peer?.add(candidate) }
            else { pendingCandidates.append(candidate) }
        case "session_config":
            let servers = Self.parseIceServers(message["ice_servers"] ?? message["iceServers"])
            if !servers.isEmpty {
                serverIceServers = servers
                event("Received ICE configuration: \(servers.count) servers")
            } else {
                event("No ICE servers provided by signalling")
            }
        case "viewer_error":
            let messageText = (message["error"] as? String ?? "Remote session error")
            // Never display token-bearing URLs or arbitrary server payloads.
            event("Server error: " + String(messageText.prefix(180)))
        case "agent_reconnecting":
            event("Waiting for endpoint to reconnect")
        case "agent_reconnected":
            event("Endpoint reconnected")
        case "session_terminated":
            let reason = message["reason"] as? String ?? "unknown"
            event("Session ended by server (\(String(reason.prefix(60))))")
            close(reason: "Session ended by server", markEnded: true)
            return
        case "chat_message":
            let body = String(message["body"] as? String ?? message["message"] as? String ?? "")
            guard !body.isEmpty else { return }
            let sender = message["display_name"] as? String ?? message["sender"] as? String ?? "Remote"
            let item = NativeChatEntry(id: message["message_id"] as? String ?? UUID().uuidString,
                                       author: sender, text: body, sentAt: Date())
            DispatchQueue.main.async { self.chat.append(item) }
        case "remote_file_list":
            let path = message["path"] as? String ?? "/"
            let rows = message["entries"] as? [[String: Any]] ?? []
            let parsed = rows.compactMap { row -> NativeFileEntry? in
                guard let name = row["name"] as? String, !name.isEmpty else { return nil }
                let full = row["path"] as? String ?? (path == "/" ? "/\(name)" : "\(path)/\(name)")
                let folder = (row["isDirectory"] as? Bool) ?? (row["is_dir"] as? Bool) ??
                    (row["type"] as? String == "directory")
                return NativeFileEntry(name: name, path: full, isDirectory: folder)
            }
            DispatchQueue.main.async {
                self.filePath = path
                self.files = parsed
                self.fileStatus = nil
            }
        case "remote_file_download":
            if let raw = message["data"] as? String, let bytes = Data(base64Encoded: raw) {
                saveDownload(bytes: bytes, name: message["name"] as? String ?? "remote-file")
            }
        case "file_transfer_start":
            let id = message["transfer_id"] as? String ?? ""
            guard !id.isEmpty, message["direction"] as? String == "download" else { return }
            let filename = message["name"] as? String ?? "remote-file"
            let path = FileManager.default.temporaryDirectory
                .appendingPathComponent("h5c-\(UUID().uuidString)-\(sanitise(filename))")
            FileManager.default.createFile(atPath: path.path, contents: nil)
            downloads[id] = (path, 0)
        case "file_transfer_chunk":
            let id = message["transfer_id"] as? String ?? ""
            guard let state = downloads[id], let raw = message["data"] as? String,
                  let bytes = Data(base64Encoded: raw), bytes.count < 1_048_576,
                  state.size + bytes.count <= 25 * 1024 * 1024 else { return }
            if let handle = try? FileHandle(forWritingTo: state.fileURL) {
                try? handle.seekToEnd()
                try? handle.write(contentsOf: bytes)
                try? handle.close()
            }
            downloads[id] = (state.fileURL, state.size + bytes.count)
        case "file_transfer_complete":
            let id = message["transfer_id"] as? String ?? ""
            guard let state = downloads.removeValue(forKey: id) else { return }
            publishDownload(state.fileURL)
        case "file_transfer_error", "remote_file_error":
            let reason = message["message"] as? String ?? "File operation failed."
            DispatchQueue.main.async { self.fileStatus = reason }
        default: break
        }
    }

    private func createAnswer(_ offerSdp: String) {
        tearDownPeer()
        remoteSdpReady = false
        if receivedOffer { pendingCandidates = [] }
        receivedOffer = true
        guard let params else { return }
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceServers = serverIceServers ?? params.iceServers
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveVideo": "true", "OfferToReceiveAudio": "true"],
            optionalConstraints: nil
        )
        guard let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            statusOnMain("Unable to start native WebRTC")
            return
        }
        self.peer = peer
        statusOnMain("Negotiating native WebRTC")
        let offer = RTCSessionDescription(type: .offer, sdp: offerSdp)
        peer.setRemoteDescription(offer) { [weak self, weak peer] error in
            guard let self, let peer else { return }
            if let error {
                self.event("Remote SDP rejected: \(error.localizedDescription)")
                return
            }
            self.event("Remote SDP accepted")
            self.remoteSdpReady = true
            for candidate in self.pendingCandidates { peer.add(candidate) }
            self.pendingCandidates = []
            peer.answer(for: constraints) { [weak self, weak peer] answer, error in
                guard let self, let peer, let answer else {
                    self?.statusOnMain("Unable to answer video offer")
                    return
                }
                if let error {
                    self.statusOnMain("SDP negotiation failed: \(error.localizedDescription)")
                    return
                }
                self.event("Native video answer created")
                peer.setLocalDescription(answer) { [weak self] error in
                    guard let self else { return }
                    if let error {
                        self.statusOnMain("Unable to set video answer: \(error.localizedDescription)")
                        return
                    }
                    self.send(["type": "webrtc_answer", "session_id": params.sessionId,
                               "sdp": answer.sdp, "sdp_type": "answer"])
                    self.event("Native video answer sent")
                }
            }
        }
    }

    private static func parseIceServers(_ raw: Any?) -> [RTCIceServer] {
        guard let rows = raw as? [[String: Any]] else { return [] }
        return rows.compactMap { record -> RTCIceServer? in
            let addresses = (record["urls"] as? [String]) ??
                (record["urls"] as? String).map { [$0] } ?? []
            let safeAddresses = addresses.filter {
                $0.hasPrefix("turn:") || $0.hasPrefix("turns:") || $0.hasPrefix("stun:")
            }
            guard !safeAddresses.isEmpty else { return nil }
            return RTCIceServer(urlStrings: safeAddresses,
                                username: record["username"] as? String ?? "",
                                credential: record["credential"] as? String ?? "")
        }
    }

    private func event(_ detail: String) {
        DispatchQueue.main.async {
            self.status = detail
            self.recentEvents.append(detail)
            if self.recentEvents.count > 20 { self.recentEvents.removeFirst() }
        }
    }

    func showError(_ detail: String) { event(detail) }

    private func statusOnMain(_ status: String) {
        DispatchQueue.main.async {
            self.status = status
        }
    }

    func sendInput(_ kind: String, values: [String: Any] = [:]) {
        guard let params, connected || hasVideo else { return }
        var payload = values
        let orderedCursor = (payload.removeValue(forKey: "_ordered") as? Bool) == true
        payload["kind"] = kind

        let isClick = ["mouse_click", "mouse_down", "mouse_up", "wheel"].contains(kind)
        if isClick {
            DispatchQueue.main.async { self.touchEventsSent += 1 }
        }

        // The Agent creates two reliable data channels. Sending mouse clicks
        // over signalling when those channels are open can result in movement
        // without a button press. Mirror the working web viewer: reliable
        // controls via input-control, otherwise input, then WebSocket fallback.
        let primary = kind == "mouse_move" && !orderedCursor
            ? [inputMoveChannel, inputControlChannel, inputChannel]
            : [inputControlChannel, inputChannel]

        if let bytes = try? JSONSerialization.data(withJSONObject: payload) {
            for candidate in primary {
                guard let channel = candidate, channel.readyState == .open else { continue }
                if channel.sendData(RTCDataBuffer(data: bytes, isBinary: false)) {
                    if isClick {
                        DispatchQueue.main.async { self.controlPath = channel.label }
                    }
                    return
                }
            }
        }

        // The WS fallback remains essential for endpoints which haven't
        // opened a WebRTC control data channel (especially Connect sessions).
        payload["type"] = "input_event"
        payload["session_id"] = params.sessionId
        send(payload)
        if isClick {
            DispatchQueue.main.async { self.controlPath = "WebSocket fallback" }
        }
    }

    func tap(x: CGFloat, y: CGFloat) {
        let p = ["x_norm": Double(min(max(x, 0), 1)),
                 "y_norm": Double(min(max(y, 0), 1))]
        sendInput("mouse_click", values: p.merging(["button": 0]) { a, _ in a })
    }

    func typeText(_ text: String) {
        guard !text.isEmpty else { return }
        sendInput("text_input", values: ["text": String(text.prefix(4000))])
    }

    // Explicit user-initiated native keyboard buttons; uses the same reliable
    // WebRTC input-control channel as mouse clicks, with signalling fallback.
    func keyPress(_ code: String) {
        let allowed = ["Backspace", "Enter", "Tab", "Escape",
                       "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete"]
        guard allowed.contains(code) else { return }
        sendInput("key_down", values: ["code": code, "key": code])
        sendInput("key_up", values: ["code": code, "key": code])
    }

    func shortcut(_ action: String) {
        if action == "ctrl_alt_del" {
            guard let params else { return }
            send(["type": "service_shortcut", "kind": "service_shortcut",
                  "action": "ctrl_alt_del_service", "session_id": params.sessionId])
        } else {
            sendInput("shortcut", values: ["action": action])
        }
    }

    func sendChat(_ body: String) {
        guard let params, connected else { return }
        let text = String(body.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        guard !text.isEmpty else { return }
        let id = UUID().uuidString
        send(["type": "chat_message", "session_id": params.sessionId,
              "sessionId": params.sessionId, "message_id": id, "messageId": id,
              "sender": "tech", "display_name": "Technician", "body": text,
              "message": text, "text": text])
        DispatchQueue.main.async {
            self.chat.append(NativeChatEntry(id: id, author: "You", text: text, sentAt: Date()))
        }
    }

    func browseFiles(_ path: String = "/") {
        guard let params, connected, path.count <= 1024 else { return }
        DispatchQueue.main.async { self.fileStatus = "Loading files…" }
        send(["type": "remote_file_list_request", "session_id": params.sessionId,
              "sessionId": params.sessionId, "path": path])
    }

    func downloadFile(_ path: String) {
        guard let params, connected, path.count <= 1024 else { return }
        DispatchQueue.main.async { self.fileStatus = "Downloading…" }
        send(["type": "remote_file_download_request", "session_id": params.sessionId,
              "sessionId": params.sessionId, "path": path])
    }

    private func sanitise(_ text: String) -> String {
        let name = (text as NSString).lastPathComponent
        let filtered = name.unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0) || "-_. ".unicodeScalars.contains($0)
        }
        return String(String.UnicodeScalarView(filtered)).prefix(100).description
    }

    private func saveDownload(bytes: Data, name: String) {
        guard bytes.count <= 25 * 1024 * 1024 else { return }
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(sanitise(name))")
        if (try? bytes.write(to: destination, options: .atomic)) != nil {
            publishDownload(destination)
        }
    }

    private func publishDownload(_ url: URL) {
        DispatchQueue.main.async {
            self.downloadedFile = url
            self.fileStatus = "Downloaded. Use Share to save to Files."
        }
    }

    func close(reason: String = "Viewer closed", markEnded: Bool = false) {
        guard !intentionallyClosed else { return }
        intentionallyClosed = true
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        socketReady = false
        session?.invalidateAndCancel()
        session = nil
        tearDownPeer()
        DispatchQueue.main.async {
            self.connected = false
            self.hasVideo = false
            self.isEnded = markEnded
            self.status = reason
        }
    }

    private func tearDownPeer() {
        videoTrack?.remove(renderer)
        videoTrack = nil
        inputChannel?.delegate = nil
        inputControlChannel?.delegate = nil
        inputMoveChannel?.delegate = nil
        inputChannel = nil
        inputControlChannel = nil
        inputMoveChannel = nil
        peer?.close()
        peer = nil
    }

    deinit {
        socket?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        peer?.close()
    }
}

extension NativeRemoteEngine: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.videoTracks.first { attach(track) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        switch newState {
        case .checking:
            event("ICE checking remote path")
        case .connected, .completed:
            DispatchQueue.main.async { self.connected = true; self.status = "Connected • waiting for video" }
            event("ICE connected")
        case .failed:
            DispatchQueue.main.async { self.connected = false; self.status = "ICE connection failed" }
            event("ICE connection failed")
        case .disconnected:
            statusOnMain("Remote connection interrupted")
            event("ICE disconnected")
        default: break
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete { event("ICE gathering complete") }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let params else { return }
        let isRelay = candidate.sdp.contains(" typ relay")
        DispatchQueue.main.async {
            self.localIceCandidates += 1
            if isRelay { self.localRelayCandidates += 1 }
        }
        send(["type": "ice_candidate", "session_id": params.sessionId,
              "candidate": candidate.sdp, "mid": candidate.sdpMid ?? "",
              "sdpMid": candidate.sdpMid ?? "",
              "mline_index": Int(candidate.sdpMLineIndex),
              "sdpMLineIndex": Int(candidate.sdpMLineIndex)])
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        switch dataChannel.label {
        case "input-control": inputControlChannel = dataChannel
        case "input": inputChannel = dataChannel
        case "input-move", "viewer-mouse-move": inputMoveChannel = dataChannel
        default: return
        }
        dataChannel.delegate = self
        DispatchQueue.main.async {
            self.controlPath = "Channel: " + dataChannel.label
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection,
                        didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        if let track = rtpReceiver.track as? RTCVideoTrack { attach(track) }
    }

    private func attach(_ track: RTCVideoTrack) {
        if videoTrack === track { return }
        videoTrack?.remove(renderer)
        videoTrack = track
        track.add(renderer)
        renderer.delegate = self
        event("Video track received")
    }
}

extension NativeRemoteEngine: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        DispatchQueue.main.async {
            if dataChannel.readyState == .open {
                self.controlPath = "Ready: " + dataChannel.label
            }
        }
    }
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {}
}

extension NativeRemoteEngine: RTCVideoViewDelegate {
    func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
        DispatchQueue.main.async {
            self.videoWidth = size.width
            self.videoHeight = size.height
            self.hasVideo = size.width > 0 && size.height > 0
            if self.hasVideo { self.status = "Streaming" }
        }
    }
}

extension NativeRemoteEngine: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        event("Signalling socket connected")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard !intentionallyClosed else { return }
        event("Signalling socket closed (code \(closeCode.rawValue))")
    }
}
