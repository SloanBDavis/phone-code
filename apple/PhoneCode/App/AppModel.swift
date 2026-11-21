import Foundation
import Observation
import PhoneCodeCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// Where the main pane is: a new chat that does not exist yet, or a session.
enum Route: Hashable, Codable {
  case new
  case session(String)

  var sessionId: String? {
    if case .session(let id) = self { return id }
    return nil
  }
}

/// App-wide state: the paired host, the protocol client, composer defaults and navigation.
@MainActor @Observable
final class AppModel {
  let client = PhoneCodeClient()
  private(set) var creds: HostCredentials?
  private(set) var images: ImageLoader?
  /// Why the pairing screen is showing, when it was not the user's choice.
  var pairReason: String?
  /// The chat on screen (iPhone) or in the focused tile (Mac).
  var route: Route = .new {
    didSet { UserDefaults.standard.set(route.sessionId, forKey: "pc.lastChat") }
  }
  /// The harness picked for the new chat before it is sent.
  var pickedHarness: String?
  var prefs: DraftPrefs {
    didSet { Self.save(prefs, "pc.draftPrefs") }
  }
  var notificationsEnabled: Bool {
    didSet {
      UserDefaults.standard.set(notificationsEnabled, forKey: "pc.notifications")
      if notificationsEnabled { Task { await Notifier.shared.requestAuthorization() } }
    }
  }
  var termFontSize: Double {
    didSet { UserDefaults.standard.set(termFontSize, forKey: "pc.termFontSize") }
  }
  /// A short message at the bottom of the screen.
  var toast: Toast?
  /// Code waiting to be redeemed (from a link opened before pairing finished).
  var pendingLink: PairingLink?
  /// Sessions shown somewhere right now (to skip notifications for them).
  var visibleSessions: Set<String> = []
  var isActive = true
  /// Launched with -PCResetState (UI tests): start from nothing, including
  /// state the system restores per window.
  let didReset = ProcessInfo.processInfo.arguments.contains("-PCResetState")
  #if os(macOS)
    /// phone-code on this Mac: connects to it without a code, pairs phones.
    let hub = MacHub()
  #endif

  private var attention = AttentionTracker()

  struct Toast: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var symbol: String = "checkmark.circle"
    var undo: (() -> Void)?
    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
  }

  init() {
    if didReset {
      Keychain.delete()
      for k in ["pc.lastChat", "pc.draftPrefs", "pc.notifications", "pc.termFontSize", "pc.workspace"] {
        UserDefaults.standard.removeObject(forKey: k)
      }
    }
    prefs = Self.load(DraftPrefs.self, "pc.draftPrefs") ?? DraftPrefs()
    notificationsEnabled = UserDefaults.standard.bool(forKey: "pc.notifications")
    let size = UserDefaults.standard.double(forKey: "pc.termFontSize")
    termFontSize = size > 0 ? size : 13
    if let last = UserDefaults.standard.string(forKey: "pc.lastChat") { route = .session(last) }
    client.onUnauthorized = { [weak self] why in self?.unpair(reason: why, tellHost: false) }
    client.onSessions = { [weak self] list in self?.sessionsChanged(list) }
    if let c = Keychain.load() { connect(c) }
    #if os(macOS)
      hub.run(self)
    #endif
    NotificationRouter.shared.attach { [weak self] id in self?.route = .session(id) }
  }

  // MARK: pairing

  var isPaired: Bool { creds != nil }

  func connect(_ c: HostCredentials) {
    creds = c
    images = ImageLoader(credentials: c)
    client.start(c)
  }

  /// Redeems a pairing code with the daemon at `origin`.
  func pair(_ link: PairingLink, origin: URL) async throws {
    let c = try await PairingClient().pair(origin: origin, code: link.code, deviceName: Device.name)
    adopt(c)
  }

  /// Stores and connects with credentials from a redeemed code.
  func adopt(_ c: HostCredentials) {
    Keychain.save(c)
    pairReason = nil
    pendingLink = nil
    route = .new
    connect(c)
  }

  func unpair(reason: String? = nil, tellHost: Bool = true) {
    if tellHost, let c = creds { Task { try? await PairingClient().unpair(c) } }
    #if os(macOS)
      // Chosen by the user: do not reconnect to this Mac's phone-code right away.
      if tellHost { hub.paused = true }
    #endif
    client.stop()
    Keychain.delete()
    creds = nil
    images = nil
    pairReason = reason
    route = .new
  }

  /// `phonecode://pair?url=…&c=…`, or a pairing link opened as a universal link.
  func handle(url: URL) {
    guard let link = PairingLink.parse(url.absoluteString) else { return }
    if isPaired, link.origin == creds?.baseURL { return }
    pendingLink = link
    if isPaired { unpair(reason: "Pair with the computer from the link you opened.", tellHost: false) }
  }

  // MARK: new chat

  var draft: NewChatChoices { prefs.choices(host: client.host, picked: pickedHarness) }

  func pickHarness(_ id: String) {
    pickedHarness = id
    if id != "terminal" { prefs.lastHarness = id }
  }

  func pickModel(_ model: String?) {
    let d = draft
    prefs.harness[d.harness, default: HarnessPrefs()].model = model
  }

  func pickMode(_ mode: PermissionMode) {
    let d = draft
    prefs.harness[d.harness, default: HarnessPrefs()].mode = mode.rawValue
  }

  func pickFolder(_ cwd: String) {
    let d = draft
    prefs.harness[d.harness, default: HarnessPrefs()].cwd = cwd
    prefs.recentDirs = Array(([cwd] + prefs.recentDirs.filter { $0 != cwd }).prefix(6))
  }

  /// First send in a new chat: the session is created with the composer's choices.
  func startChat(text: String, attachments: [PhoneCodeCore.Attachment]) async -> String? {
    let d = draft
    do {
      let s = try await client.startChat(d, text: text, attachments: attachments)
      prefs.remember(d)
      pickedHarness = nil
      route = .session(s.id)
      Haptics.play(.send)
      return s.id
    } catch {
      show("\(error)", symbol: "exclamationmark.triangle")
      return nil
    }
  }

  func openTerminal(cols: Int = 80, rows: Int = 24) async -> String? {
    do {
      let s = try await client.openTerminal(cwd: draft.cwd, cols: cols, rows: rows)
      route = .session(s.id)
      return s.id
    } catch {
      show("\(error)", symbol: "exclamationmark.triangle")
      return nil
    }
  }

  // MARK: session actions

  func archive(_ s: SessionInfo) {
    Haptics.play(.archive)
    if route == .session(s.id) { route = .new }
    show("Archived", symbol: "archivebox") { [weak self] in
      Task { try? await self?.client.archive(s.id, false) }
    }
    Task {
      do { try await client.archive(s.id, true) } catch {
        show("Archiving needs a newer phone-code on your computer", symbol: "exclamationmark.triangle")
      }
    }
  }

  func delete(_ s: SessionInfo) {
    if route == .session(s.id) { route = .new }
    Task {
      do { try await client.delete(s.id) } catch { show("Delete failed: \(error)", symbol: "exclamationmark.triangle") }
    }
  }

  func rename(_ s: SessionInfo, to title: String) {
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t != s.title else { return }
    Task {
      do { try await client.rename(s.id, title: t) } catch { show("Rename failed: \(error)", symbol: "exclamationmark.triangle") }
    }
  }

  func open(_ r: ResumableSession) async {
    do {
      let id = try await client.open(r)
      route = .session(id)
    } catch {
      show("Could not open that chat: \(error)", symbol: "exclamationmark.triangle")
    }
  }

  func show(_ text: String, symbol: String = "checkmark.circle", undo: (() -> Void)? = nil) {
    let t = Toast(text: text, symbol: symbol, undo: undo)
    toast = t
    Task {
      try? await Task.sleep(for: .seconds(undo == nil ? 2.5 : 5))
      if toast == t { toast = nil }
    }
  }

  // MARK: notifications

  private func sessionsChanged(_ list: [SessionInfo]) {
    let events = attention.update(list)
    guard notificationsEnabled else { return }
    for e in events {
      let id = e.session.id
      if isActive, visibleSessions.contains(id) { continue }
      Notifier.shared.post(e)
    }
  }

  // MARK: persistence helpers

  static func load<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
    guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(T.self, from: d)
  }

  static func save<T: Encodable>(_ value: T, _ key: String) {
    if let d = try? JSONEncoder().encode(value) { UserDefaults.standard.set(d, forKey: key) }
  }
}

enum Device {
  static var name: String {
    #if os(iOS)
      UIDevice.current.userInterfaceIdiom == .pad ? "iPad app" : "iPhone app"
    #else
      "Mac app (\(Host.current().localizedName ?? "Mac"))"
    #endif
  }
}
