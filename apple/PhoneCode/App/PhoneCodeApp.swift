import PhoneCodeCore
import SwiftUI

@main
struct PhoneCodeApp: App {
  @State private var model = AppModel()
  #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  #endif

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .onOpenURL { model.handle(url: $0) }
        #if os(macOS)
          .modifier(UpdatePrompt())
        #endif
    }
    #if os(macOS)
      .defaultSize(width: 1280, height: 820)
      .commands {
        SidebarCommands()
        AppCommands(model: model)
      }
    #endif

    #if os(macOS)
      Settings {
        SettingsView()
          .environment(model)
          .frame(width: 520, height: 560)
      }
    #endif
  }
}

#if os(iOS)
  import UIKit
  import UserNotifications

  /// Shows local notifications while the app is in the foreground too, and
  /// opens the chat a tapped notification belongs to.
  final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
      _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
      UNUserNotificationCenter.current().delegate = self
      return true
    }

    nonisolated func userNotificationCenter(
      _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
      [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
      let id = response.notification.request.content.userInfo["sessionId"] as? String
      if let id { await MainActor.run { NotificationRouter.shared.open(id) } }
    }
  }
#endif

/// Hands a tapped notification's session to whichever view model is listening.
@MainActor
final class NotificationRouter {
  static let shared = NotificationRouter()
  var handler: ((String) -> Void)?
  private var pendingId: String?

  func open(_ sessionId: String) {
    if let handler { handler(sessionId) } else { pendingId = sessionId }
  }

  func attach(_ h: @escaping (String) -> Void) {
    handler = h
    if let p = pendingId {
      pendingId = nil
      h(p)
    }
  }
}
