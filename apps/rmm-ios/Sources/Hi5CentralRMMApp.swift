import SwiftUI

@main
struct Hi5CentralRMMApp: App {
    @StateObject private var state = RMMState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .tint(Color(red: 0.18, green: 0.48, blue: 0.96))
        }
    }
}
