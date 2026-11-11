import SwiftUI
import UIKit

/// Receives native touches above the Metal WebRTC renderer. RTCMTLVideoView
/// remains solely responsible for video; it does not own gesture recognition.
struct NativeRemoteTouchSurface: UIViewRepresentable {
    @Binding var zoom: CGFloat
    let videoSize: CGSize
    let active: Bool
    let send: (String, [String: Any]) -> Void

    func makeUIView(context: Context) -> RemoteTouchUIView {
        let view = RemoteTouchUIView(frame: .zero)
        view.backgroundColor = .clear
        view.isOpaque = false
        view.isMultipleTouchEnabled = true
        view.contentMode = .redraw
        view.zoomChanged = { next in
            DispatchQueue.main.async {
                zoom = next
            }
        }
        view.send = send
        return view
    }

    func updateUIView(_ view: RemoteTouchUIView, context: Context) {
        view.videoSize = videoSize
        view.zoom = zoom
        view.active = active
        view.send = send
        view.zoomChanged = { next in
            DispatchQueue.main.async {
                zoom = next
            }
        }
        if !active { view.cancelActiveTouches() }
    }
}

final class RemoteTouchUIView: UIView {
    var videoSize: CGSize = .zero
    var zoom: CGFloat = 1
    var active = false
    var send: ((String, [String: Any]) -> Void)?
    var zoomChanged: ((CGFloat) -> Void)?

    private enum TwoFingerMode {
        case undecided, zooming, scrolling
    }

    private var locations: [ObjectIdentifier: CGPoint] = [:]
    private var primaryTouch: ObjectIdentifier?
    private var start: CGPoint = .zero
    private var last: CGPoint = .zero
    private var dragging = false
    private var longPressSent = false
    private var blockedByMultitouch = false
    private var longPress: DispatchWorkItem?
    private var lastMoveAt: TimeInterval = 0

    private var twoFingerMode: TwoFingerMode = .undecided
    private var firstPairDistance: CGFloat = 0
    private var lastPairCenter: CGPoint = .zero
    private var zoomAtPairStart: CGFloat = 1
    private var wheelAccumulator: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        isUserInteractionEnabled = true
        accessibilityLabel = "Remote desktop touch surface"
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        isMultipleTouchEnabled = true
        isUserInteractionEnabled = true
    }

    // Convert the point on the *unscaled* UIKit touch layer to the desktop
    // image displayed by the aspect-fit and optional zoomed Metal renderer.
    // Ignore black letterboxing instead of sending clicks outside the video.
    private func remotePoint(_ local: CGPoint) -> [String: Any]? {
        guard bounds.width > 0, bounds.height > 0,
              videoSize.width > 0, videoSize.height > 0 else { return nil }

        let currentZoom = max(1, zoom)
        let unscaled = CGPoint(
            x: bounds.midX + (local.x - bounds.midX) / currentZoom,
            y: bounds.midY + (local.y - bounds.midY) / currentZoom
        )
        let fit = min(bounds.width / videoSize.width,
                      bounds.height / videoSize.height)
        let imageWidth = videoSize.width * fit
        let imageHeight = videoSize.height * fit
        guard imageWidth > 0, imageHeight > 0 else { return nil }

        let left = bounds.midX - imageWidth / 2
        let top = bounds.midY - imageHeight / 2
        let x = (unscaled.x - left) / imageWidth
        let y = (unscaled.y - top) / imageHeight
        guard x >= 0, x <= 1, y >= 0, y <= 1 else { return nil }
        return ["x_norm": Double(x), "y_norm": Double(y)]
    }

    private func point(_ a: CGPoint, distanceTo b: CGPoint) -> CGFloat {
        hypot(a.x - b.x, a.y - b.y)
    }

    private func cancelLongPress() {
        longPress?.cancel()
        longPress = nil
    }

    private func sendMove(_ p: CGPoint) {
        guard active, let coords = remotePoint(p) else { return }
        send?("mouse_move", coords)
    }

    private func sendClick(_ p: CGPoint, button: Int) {
        guard active, var coords = remotePoint(p) else { return }
        // Move first to provide a correct target even if a hardware cursor
        // was left at a different position from the most recent video frame.
        send?("mouse_move", coords)
        coords["button"] = button
        send?("mouse_click", coords)
    }

    private func scheduleLongPress() {
        cancelLongPress()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.locations.count == 1,
                  !self.dragging, !self.blockedByMultitouch else { return }
            self.longPressSent = true
            self.sendClick(self.last, button: 2)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        longPress = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.65, execute: work)
    }

    private func beginMultiTouch() {
        cancelLongPress()
        if dragging {
            send?("mouse_up", ["button": 0])
            dragging = false
        }
        primaryTouch = nil
        blockedByMultitouch = true
        longPressSent = false
        if let pair = pair() {
            firstPairDistance = max(1, point(pair.0, distanceTo: pair.1))
            lastPairCenter = CGPoint(x: (pair.0.x + pair.1.x) / 2,
                                     y: (pair.0.y + pair.1.y) / 2)
        }
        zoomAtPairStart = zoom
        twoFingerMode = .undecided
        wheelAccumulator = 0
    }

    private func pair() -> (CGPoint, CGPoint)? {
        let values = Array(locations.values)
        guard values.count >= 2 else { return nil }
        return (values[0], values[1])
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        for touch in touches {
            locations[ObjectIdentifier(touch)] = touch.location(in: self)
        }
        if locations.count >= 2 {
            if !blockedByMultitouch { beginMultiTouch() }
            return
        }

        guard let touch = touches.first, locations.count == 1,
              !blockedByMultitouch else { return }
        let position = touch.location(in: self)
        primaryTouch = ObjectIdentifier(touch)
        start = position
        last = position
        dragging = false
        longPressSent = false
        lastMoveAt = 0
        sendMove(position)
        scheduleLongPress()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        for touch in touches {
            let id = ObjectIdentifier(touch)
            if locations[id] != nil {
                locations[id] = touch.location(in: self)
            }
        }
        if locations.count >= 2 {
            handleMultiTouch()
            return
        }
        guard !blockedByMultitouch, let touch = touches.first,
              ObjectIdentifier(touch) == primaryTouch else { return }

        let p = touch.location(in: self)
        let movement = point(p, distanceTo: start)
        if movement > 6 { cancelLongPress() }
        if longPressSent { last = p; return }

        if !dragging && movement > 11, remotePoint(p) != nil {
            // Windows drag requires a mouse-down and an eventual mouse-up,
            // rather than sending clicks repeatedly while moving a finger.
            sendMove(start)
            send?("mouse_down", ["button": 0])
            dragging = true
        }

        if dragging {
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastMoveAt > 1.0 / 60.0 {
                sendMove(p)
                lastMoveAt = now
            }
        }
        last = p
    }

    private func handleMultiTouch() {
        guard let points = pair() else { return }
        let center = CGPoint(x: (points.0.x + points.1.x) / 2,
                             y: (points.0.y + points.1.y) / 2)
        let distance = max(1, point(points.0, distanceTo: points.1))
        let distanceDelta = abs(distance - firstPairDistance)
        let centerMovement = point(center, distanceTo: lastPairCenter)

        if twoFingerMode == .undecided {
            if distanceDelta > 13 {
                twoFingerMode = .zooming
            } else if centerMovement > 5 {
                twoFingerMode = .scrolling
            }
        }

        switch twoFingerMode {
        case .zooming:
            let next = min(4, max(1, zoomAtPairStart * distance / firstPairDistance))
            if abs(next - zoom) > 0.005 {
                zoom = next
                zoomChanged?(next)
            }
        case .scrolling:
            // Matches the browser viewer's fixed 120-unit wheel increments:
            // two fingers up scroll the remote computer down.
            wheelAccumulator += lastPairCenter.y - center.y
            let steps = Int(wheelAccumulator / 40)
            if steps != 0 {
                let capped = max(-3, min(3, steps))
                send?("wheel", [
                    "delta_x": 0,
                    "delta_y": capped * 120,
                    "delta_mode": 0
                ])
                wheelAccumulator -= CGFloat(capped) * 40
            }
        case .undecided:
            break
        }
        lastPairCenter = center
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        for touch in touches {
            let id = ObjectIdentifier(touch)
            if id == primaryTouch, !blockedByMultitouch {
                cancelLongPress()
                if dragging {
                    send?("mouse_up", ["button": 0])
                } else if !longPressSent {
                    sendClick(touch.location(in: self), button: 0)
                }
                dragging = false
                primaryTouch = nil
                longPressSent = false
            }
            locations.removeValue(forKey: id)
        }
        if locations.isEmpty {
            resetTouchState()
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        cancelActiveTouches()
    }

    func cancelActiveTouches() {
        cancelLongPress()
        if dragging {
            send?("mouse_up", ["button": 0])
        }
        locations.removeAll()
        resetTouchState()
    }

    private func resetTouchState() {
        cancelLongPress()
        primaryTouch = nil
        dragging = false
        longPressSent = false
        blockedByMultitouch = false
        wheelAccumulator = 0
        twoFingerMode = .undecided
    }
}
