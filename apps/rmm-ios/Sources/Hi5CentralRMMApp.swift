import SwiftUI
import UserNotifications

#if !HI5CENTRAL_UNIFIED
@main
struct Hi5CentralRMMApp: App {
    @StateObject private var state = RMMState()
    @StateObject private var client = RMMClient()

    init() {
        UNUserNotificationCenter.current().delegate = NativeNotificationPresenter.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .environmentObject(client)
                .tint(Color(red: 0.18, green: 0.48, blue: 0.96))
        }
    }
}

#endif
