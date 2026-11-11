import ActivityKit
import Foundation

@MainActor
final class RemoteSessionActivity {
    static let shared = RemoteSessionActivity()
    private init() {}

    func start(sessionId: String, deviceName: String, state: String) async {
        guard #available(iOS 16.2, *),
              ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // Avoid duplicate Dynamic Island entries on a reconnect.
        if Activity<Hi5RemoteActivityAttributes>.activities.contains(where: { $0.attributes.sessionId == sessionId }) {
            await update(sessionId: sessionId, state: state)
            return
        }
        let attributes = Hi5RemoteActivityAttributes(sessionId: sessionId, deviceName: deviceName)
        let content = ActivityContent(state: Hi5RemoteActivityAttributes.ContentState(phase: state, updatedAt: Date()),
                                      staleDate: nil)
        do {
            _ = try Activity.request(attributes: attributes, content: content, pushType: nil)
        } catch {
            // Failure to start a Live Activity must never block remote access.
        }
    }

    func update(sessionId: String, state: String) async {
        guard #available(iOS 16.2, *) else { return }
        let content = ActivityContent(
            state: Hi5RemoteActivityAttributes.ContentState(phase: state, updatedAt: Date()),
            staleDate: nil
        )
        for activity in Activity<Hi5RemoteActivityAttributes>.activities where activity.attributes.sessionId == sessionId {
            await activity.update(content)
        }
    }

    func end(sessionId: String) async {
        guard #available(iOS 16.2, *) else { return }
        let content = ActivityContent(
            state: Hi5RemoteActivityAttributes.ContentState(phase: "Disconnected", updatedAt: Date()),
            staleDate: nil
        )
        for activity in Activity<Hi5RemoteActivityAttributes>.activities where activity.attributes.sessionId == sessionId {
            await activity.end(content, dismissalPolicy: .immediate)
        }
    }
}
