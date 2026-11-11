import SwiftUI
import UIKit

/// An interactive UIKit layer ABOVE the Metal WebRTC video renderer.
/// Its viewport transform must exactly match the video's scaleEffect/offset.
struct NativeRemoteTouchSurface: UIViewRepresentable {
    @Binding var zoom: CGFloat
    @Binding var pan: CGSize
    @Binding var panMode: Bool
    let videoSize: CGSize
    let active: Bool
    let onTouch: (CGPoint) -> Void
    let send: (String, [String: Any]) -> Void

    func makeUIView(context: Context) -> RemoteTouchUIView {
        let view = RemoteTouchUIView(frame: .zero)
        view.backgroundColor = .clear
        view.isOpaque = false
        view.isMultipleTouchEnabled = true
        view.onViewportChange = { nextZoom, nextPan, shouldPan in
            DispatchQueue.main.async {
                zoom = nextZoom
                pan = nextPan
                if shouldPan { panMode = true }
            }
        }
        view.onTouch = onTouch
        view.send = send
        return view
    }

    func updateUIView(_ view: RemoteTouchUIView, context: Context) {
        view.videoSize = videoSize
        view.zoom = zoom
        view.pan = pan
        view.panMode = panMode
        view.active = active
        view.send = send
        view.onTouch = onTouch
        view.onViewportChange = { nextZoom, nextPan, shouldPan in
            DispatchQueue.main.async {
                zoom = nextZoom
                pan = nextPan
                if shouldPan { panMode = true }
            }
        }
        if !active { view.cancelActiveTouches() }
    }
}

final class RemoteTouchUIView: UIView {
    var videoSize: CGSize = .zero
    var zoom: CGFloat = 1
    var pan: CGSize = .zero
    var panMode = true
    var active = false
    var send: ((String, [String: Any]) -> Void)?
    var onTouch: ((CGPoint) -> Void)?
    var onViewportChange: ((CGFloat, CGSize, Bool) -> Void)?

    private enum TwoFingerMode { case undecided, navigate, scroll }
    private var points: [ObjectIdentifier: CGPoint] = [:]
    private var primary: ObjectIdentifier?
    private var initial: CGPoint = .zero
    private var last: CGPoint = .zero
    private var panAtStart: CGSize = .zero
    private var draggingRemote = false
    private var movedViewport = false
    private var longPressFired = false
    private var multiTouchConsumed = false
    private var longPress: DispatchWorkItem?
    private var lastMoveAt: TimeInterval = 0

    private var gesture: TwoFingerMode = .undecided
    private var initialSeparation: CGFloat = 1
    private var initialZoom: CGFloat = 1
    private var pinchAnchor: CGPoint = .zero
    private var initialCenter: CGPoint = .zero
    private var previousCenter: CGPoint = .zero
    private var scrollAccum: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        isUserInteractionEnabled = true
        isMultipleTouchEnabled = true
        accessibilityLabel = "Hi5Central remote desktop interaction surface"
    }

    private var center: CGPoint { CGPoint(x: bounds.midX, y: bounds.midY) }

    private func contentSize() -> CGSize {
        guard bounds.width > 0, bounds.height > 0,
              videoSize.width > 0, videoSize.height > 0 else { return .zero }
        let ratio = min(bounds.width / videoSize.width, bounds.height / videoSize.height)
        return CGSize(width: videoSize.width * ratio, height: videoSize.height * ratio)
    }

    private func clampedPan(_ proposed: CGSize, zoom proposedZoom: CGFloat) -> CGSize {
        let video = contentSize()
        let marginX = max(0, (video.width * proposedZoom - bounds.width) / 2)
        let marginY = max(0, (video.height * proposedZoom - bounds.height) / 2)
        return CGSize(
            width: min(marginX, max(-marginX, proposed.width)),
            height: min(marginY, max(-marginY, proposed.height))
        )
    }

    private func desktopPoint(_ screenPoint: CGPoint) -> [String: Any]? {
        let video = contentSize()
        guard video.width > 0, video.height > 0 else { return nil }
        let c = center
        let unscaled = CGPoint(
            x: c.x + (screenPoint.x - c.x - pan.width) / max(1, zoom),
            y: c.y + (screenPoint.y - c.y - pan.height) / max(1, zoom)
        )
        let left = c.x - video.width / 2
        let top = c.y - video.height / 2
        let x = (unscaled.x - left) / video.width
        let y = (unscaled.y - top) / video.height
        guard (0...1).contains(x), (0...1).contains(y) else { return nil }
        return ["x_norm": Double(x), "y_norm": Double(y)]
    }

    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        hypot(a.x - b.x, a.y - b.y)
    }

    private func clearLongPress() {
        longPress?.cancel()
        longPress = nil
    }

    private func moveMouse(_ at: CGPoint) {
        guard active, let point = desktopPoint(at) else { return }
        send?("mouse_move", point)
    }

    private func click(_ at: CGPoint, button: Int) {
        guard active, var point = desktopPoint(at) else { return }
        // Include x/y with the click; don't rely on an independent mouse-move
        // arriving on a different WebRTC data channel before the click.
        send?("mouse_move", point)
        point["button"] = button
        send?("mouse_click", point)
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func armLongPress() {
        clearLongPress()
        let task = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.points.count == 1,
                  !self.multiTouchConsumed, !self.draggingRemote,
                  !self.movedViewport else { return }
            self.longPressFired = true
            self.click(self.last, button: 2)
        }
        longPress = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.62, execute: task)
    }

    private func pair() -> (CGPoint, CGPoint)? {
        let values = Array(points.values)
        guard values.count >= 2 else { return nil }
        return (values[0], values[1])
    }

    private func beginMultiTouch() {
        clearLongPress()
        if draggingRemote {
            send?("mouse_up", ["button": 0])
            draggingRemote = false
        }
        primary = nil
        multiTouchConsumed = true
        movedViewport = false
        gesture = .undecided
        scrollAccum = 0
        guard let (a, b) = pair() else { return }
        initialSeparation = max(1, distance(a, b))
        let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        initialCenter = mid
        previousCenter = mid
        initialZoom = zoom
        panAtStart = pan
        let c = center
        // This precise untransformed point remains pinned beneath the
        // fingers as pinch magnification and two-finger panning happen.
        pinchAnchor = CGPoint(
            x: c.x + (mid.x - c.x - pan.width) / max(1, zoom),
            y: c.y + (mid.y - c.y - pan.height) / max(1, zoom)
        )
        if zoom > 1.02 { gesture = .navigate }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        for touch in touches { points[ObjectIdentifier(touch)] = touch.location(in: self) }
        if points.count >= 2 {
            if !multiTouchConsumed { beginMultiTouch() }
            return
        }
        guard let touch = touches.first, points.count == 1, !multiTouchConsumed else { return }
        let p = touch.location(in: self)
        primary = ObjectIdentifier(touch)
        initial = p
        last = p
        panAtStart = pan
        draggingRemote = false
        movedViewport = false
        longPressFired = false
        lastMoveAt = 0
        onTouch?(p)
        if desktopPoint(p) != nil { moveMouse(p); armLongPress() }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        for touch in touches {
            let key = ObjectIdentifier(touch)
            if points[key] != nil { points[key] = touch.location(in: self) }
        }
        if points.count >= 2 { updateMultiTouch(); return }
        guard !multiTouchConsumed, let touch = touches.first,
              ObjectIdentifier(touch) == primary else { return }
        let p = touch.location(in: self)
        let travelled = distance(p, initial)
        if travelled > 6 { clearLongPress() }
        if longPressFired { last = p; return }

        if zoom > 1.02 && panMode {
            if travelled > 7 { movedViewport = true }
            if movedViewport {
                let proposed = CGSize(
                    width: panAtStart.width + p.x - initial.x,
                    height: panAtStart.height + p.y - initial.y
                )
                pan = clampedPan(proposed, zoom: zoom)
                onViewportChange?(zoom, pan, false)
            }
            last = p
            return
        }

        if !draggingRemote && travelled > 11 && desktopPoint(initial) != nil {
            moveMouse(initial)
            var data = desktopPoint(initial) ?? [:]
            data["button"] = 0
            send?("mouse_down", data)
            draggingRemote = true
        }
        if draggingRemote {
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastMoveAt > 1.0 / 60.0 {
                moveMouse(p)
                lastMoveAt = now
            }
        }
        last = p
    }

    private func updateMultiTouch() {
        guard let (a, b) = pair() else { return }
        let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        let separation = max(1, distance(a, b))
        if gesture == .undecided {
            if abs(separation - initialSeparation) > 11 {
                gesture = .navigate
            } else if distance(mid, initialCenter) > 9 {
                gesture = .scroll
            }
        }
        switch gesture {
        case .navigate:
            let nextZoom = min(6, max(1, initialZoom * separation / initialSeparation))
            let c = center
            let suggested = CGSize(
                width: mid.x - c.x - nextZoom * (pinchAnchor.x - c.x),
                height: mid.y - c.y - nextZoom * (pinchAnchor.y - c.y)
            )
            let nextPan = clampedPan(suggested, zoom: nextZoom)
            zoom = nextZoom
            pan = nextPan
            onViewportChange?(nextZoom, nextPan, true)
        case .scroll:
            // At 1x, two fingers scroll the remote computer; while zoomed,
            // two fingers always navigate the viewport.
            scrollAccum += previousCenter.y - mid.y
            let steps = Int(scrollAccum / 40)
            if steps != 0 {
                let amount = max(-3, min(3, steps))
                send?("wheel", ["delta_x": 0, "delta_y": amount * 120, "delta_mode": 0])
                scrollAccum -= CGFloat(amount) * 40
            }
        case .undecided:
            break
        }
        previousCenter = mid
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        for touch in touches {
            let id = ObjectIdentifier(touch)
            if id == primary && !multiTouchConsumed {
                clearLongPress()
                let location = touch.location(in: self)
                if draggingRemote {
                    var payload = desktopPoint(location) ?? [:]
                    payload["button"] = 0
                    send?("mouse_up", payload)
                } else if !movedViewport && !longPressFired {
                    click(location, button: 0)
                }
                draggingRemote = false
                primary = nil
                longPressFired = false
            }
            points.removeValue(forKey: id)
        }
        if points.isEmpty { reset() }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        cancelActiveTouches()
    }

    func cancelActiveTouches() {
        clearLongPress()
        if draggingRemote { send?("mouse_up", ["button": 0]) }
        points.removeAll()
        reset()
    }

    private func reset() {
        clearLongPress()
        primary = nil
        multiTouchConsumed = false
        draggingRemote = false
        movedViewport = false
        longPressFired = false
        scrollAccum = 0
        gesture = .undecided
    }
}
