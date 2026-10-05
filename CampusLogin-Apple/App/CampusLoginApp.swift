import SwiftUI
#if os(macOS)
import AppKit
#endif

@main @MainActor struct CampusLoginApp: App {
    @StateObject private var model = CampusModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView(model: model)
                .onAppear { model.sceneActive(true) }
                #if os(macOS)
                .frame(minWidth: 480, minHeight: 640)
                #endif
        }
        .onChange(of: phase) { newPhase in
            // System permission sheets make the scene inactive without backgrounding it.
            if newPhase != .inactive { model.sceneActive(newPhase == .active) }
        }
        #if os(macOS)
        .defaultSize(width: 540, height: 780)
        MenuBarExtra("CampusLogin", systemImage: model.online ? "network.badge.shield.half.filled" : "network") {
            MenuContent(model: model)
        }
        #endif
    }
}

#if os(macOS)
@MainActor private struct MenuContent: View {
    @ObservedObject var model: CampusModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(model.status)
        Text(model.detail)
        Divider()
        Button("检查并登录") { model.start() }.disabled(model.working)
        Button("暂停自动检查") { model.pause() }
        Button("打开控制面板") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Divider()
        Button("退出") { NSApp.terminate(nil) }
    }
}
#endif
