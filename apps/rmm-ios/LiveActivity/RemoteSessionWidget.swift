import ActivityKit
import WidgetKit
import SwiftUI

@main
struct Hi5ActivityBundle: WidgetBundle {
    var body: some Widget {
        Hi5RemoteSessionWidget()
    }
}

struct Hi5RemoteSessionWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: Hi5RemoteActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(.blue)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Hi5Central remote session").font(.headline)
                    Text(context.state.phase).font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "arrow.up.forward.app")
                    .foregroundStyle(.blue)
            }
            .padding(15)
            .activityBackgroundTint(Color.black.opacity(0.04))
            .widgetURL(URL(string: "hi5central-rmm://remote?session=\(context.attributes.sessionId)"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Hi5Central", systemImage: "desktopcomputer")
                        .font(.caption.bold())
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Image(systemName: "arrow.up.forward.app")
                        .foregroundStyle(.blue)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 9) {
                        Circle().fill(context.state.phase == "Connected" ? Color.green : Color.orange)
                            .frame(width: 8, height: 8)
                        Text(context.state.phase).font(.subheadline)
                        Spacer()
                        Text("Tap to return").font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: "desktopcomputer").foregroundStyle(.blue)
            } compactTrailing: {
                Circle().fill(context.state.phase == "Connected" ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
            } minimal: {
                Image(systemName: "desktopcomputer").foregroundStyle(.blue)
            }
            .widgetURL(URL(string: "hi5central-rmm://remote?session=\(context.attributes.sessionId)"))
        }
    }
}
