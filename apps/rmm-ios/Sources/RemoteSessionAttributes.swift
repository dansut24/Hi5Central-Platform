import ActivityKit
import Foundation

struct Hi5RemoteActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String
        var updatedAt: Date
    }

    // A device display label and random session ID only. Never include a
    // session token, websocket URL, tenant cookie, or credentials.
    let sessionId: String
    let deviceName: String
}
