import Foundation
import PhoneCodeCore
import Security
import SwiftUI
import UserNotifications

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// Where this device's token for the computer is kept.
///
/// iPhone: the Keychain, this device only.
/// Mac: a file only this user can read, in the app's Application Support
/// folder. The Keychain ties an item to the signature of the app that made
/// it, so every locally built (ad-hoc signed) version asked to unlock it; and
/// on the Mac it protects nothing extra, since anything running as this user
/// can read phone-code's own control token in ~/.phonecode anyway.
enum CredentialStore {
  static func save(_ c: HostCredentials) {
    guard let data = try? JSONEncoder().encode(c) else { return }
    #if os(macOS)
      let url = fileURL
      try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    #else
      SecItemDelete(query as CFDictionary)
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(add as CFDictionary, nil)
    #endif
  }

  static func load() -> HostCredentials? {
    #if os(macOS)
      guard let data = try? Data(contentsOf: fileURL) else { return nil }
    #else
      var q = query
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    #endif
    return try? JSONDecoder().decode(HostCredentials.self, from: data)
  }

  static func delete() {
    #if os(macOS)
      try? FileManager.default.removeItem(at: fileURL)
    #else
      SecItemDelete(query as CFDictionary)
    #endif
  }

  #if os(macOS)
    /// ~/Library/Application Support/<bundle id>/credentials.json (per bundle id,
    /// so a test build never touches the real app's pairing).
    private static var fileURL: URL {
      let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      return base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "phone-code", isDirectory: true)
        .appendingPathComponent("credentials.json")
    }
  #else
    private static var query: [String: Any] {
      [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "phone-code",
        kSecAttrAccount as String: "host",
      ]
    }
  #endif
}

enum Haptics {
  enum Kind { case send, archive, allow, deny, select }

  static func play(_ k: Kind) {
    #if os(iOS)
      switch k {
      case .send: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      case .archive: UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
      case .allow: UINotificationFeedbackGenerator().notificationOccurred(.success)
      case .deny: UINotificationFeedbackGenerator().notificationOccurred(.warning)
      case .select: UISelectionFeedbackGenerator().selectionChanged()
      }
    #endif
  }
}

/// Local notifications for sessions that need the user or finished. Remote
/// push (APNs) is not implemented: see apple/README.md.
@MainActor
final class Notifier {
  static let shared = Notifier()

  func requestAuthorization() async {
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
  }

  func post(_ e: AttentionTracker.Event) {
    let content = UNMutableNotificationContent()
    let s = e.session
    switch e {
    case .needsYou:
      content.title = s.title
      content.body = "Needs you: approve or answer to continue."
    case .finished:
      content.title = s.title
      content.body = s.preview.map(Markdown.plain) ?? "Finished."
    case .failed:
      content.title = s.title
      content.body = "Stopped with an error."
    }
    content.sound = .default
    content.threadIdentifier = s.id
    content.userInfo = ["sessionId": s.id]
    let req = UNNotificationRequest(identifier: "\(s.id)-\(e.kindName)", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req) { _ in }
  }
}

extension AttentionTracker.Event {
  var kindName: String {
    switch self {
    case .needsYou: "needs"
    case .finished: "done"
    case .failed: "failed"
    }
  }
}

enum Clipboard {
  static func copy(_ s: String) {
    #if os(iOS)
      UIPasteboard.general.string = s
    #else
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(s, forType: .string)
    #endif
  }

  static var string: String? {
    #if os(iOS)
      UIPasteboard.general.string
    #else
      NSPasteboard.general.string(forType: .string)
    #endif
  }
}

#if os(iOS)
  typealias PlatformImage = UIImage
#else
  typealias PlatformImage = NSImage
#endif

extension Image {
  init(platformImage: PlatformImage) {
    #if os(iOS)
      self.init(uiImage: platformImage)
    #else
      self.init(nsImage: platformImage)
    #endif
  }
}

extension Date {
  /// "now", "5m", "3h", "2d", or a date.
  static func short(_ ms: Double) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    let s = -d.timeIntervalSinceNow
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86400 { return "\(Int(s / 3600))h" }
    if s < 7 * 86400 { return "\(Int(s / 86400))d" }
    return d.formatted(date: .abbreviated, time: .omitted)
  }
}

/// "~/project" for paths in the user's home.
func tildePath(_ path: String, home: String?) -> String {
  guard let home, !home.isEmpty, path.hasPrefix(home) else { return path }
  return "~" + path.dropFirst(home.count)
}

extension View {
  /// An identifier for UI tests on a view that contains other elements. Without
  /// `.contain`, SwiftUI gives the identifier to every child and hides theirs.
  func axContainer(_ id: String) -> some View {
    accessibilityElement(children: .contain).accessibilityIdentifier(id)
  }
}
