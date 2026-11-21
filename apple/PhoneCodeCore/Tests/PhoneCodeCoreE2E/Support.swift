import Foundation
import PhoneCodeCore
import Testing

/// Wraps the platform WebSocket so tests can see every frame and drop the link.
final class RecordingFactory: WebSocketFactory, @unchecked Sendable {
  private let inner = WebSockets.platformDefault
  private let lock = NSLock()
  private var socketsList: [RecordingSocket] = []
  private var sentList: [String] = []
  private var receivedList: [String] = []
  private var refuse = false

  var sent: [String] { lock.withLock { sentList } }
  var received: [String] { lock.withLock { receivedList } }
  var connections: Int { lock.withLock { socketsList.count } }

  func connect(to url: URL) async throws -> WebSocket {
    if lock.withLock({ refuse }) { throw WebSocketClosed(code: nil, reason: "refused by test") }
    let s = RecordingSocket(try await inner.connect(to: url), owner: self)
    lock.withLock { socketsList.append(s) }
    return s
  }

  func recordSent(_ t: String) { lock.withLock { sentList.append(t) } }
  func recordReceived(_ t: String) { lock.withLock { receivedList.append(t) } }

  /// Kills the current socket as a network drop would.
  func dropAll() {
    for s in lock.withLock({ socketsList }) { s.close(code: 4000) }
  }

  func setRefuse(_ v: Bool) { lock.withLock { refuse = v } }

  /// Received frames of type `t` (decoded loosely) after index `from`.
  func frames(_ t: String, from: Int = 0) -> [[String: JSONValue]] {
    let all = received
    return all[min(from, all.count)...].compactMap { s in
      guard let j = try? JSONDecoder().decode([String: JSONValue].self, from: Data(s.utf8)), j["t"]?.stringValue == t else {
        return nil
      }
      return j
    }
  }

  func sentFrames(_ t: String) -> [[String: JSONValue]] {
    sent.compactMap { s in
      guard let j = try? JSONDecoder().decode([String: JSONValue].self, from: Data(s.utf8)), j["t"]?.stringValue == t else {
        return nil
      }
      return j
    }
  }
}

final class RecordingSocket: WebSocket, @unchecked Sendable {
  let inner: WebSocket
  weak var owner: RecordingFactory?
  init(_ inner: WebSocket, owner: RecordingFactory) {
    self.inner = inner
    self.owner = owner
  }
  func send(_ text: String) async throws {
    owner?.recordSent(text)
    try await inner.send(text)
  }
  func receive() async throws -> Data {
    let d = try await inner.receive()
    owner?.recordReceived(String(decoding: d, as: UTF8.self))
    return d
  }
  func close(code: Int) { inner.close(code: code) }
  var bufferedAmount: Int { inner.bufferedAmount }
}

/// Polls `cond` on the main actor until it holds.
@MainActor
func waitUntil(
  _ what: @autoclosure () -> String = "condition", timeout: Double = 20, sourceLocation: SourceLocation = #_sourceLocation,
  _ cond: () -> Bool
) async throws {
  let deadline = Date().addingTimeInterval(timeout)
  while !cond() {
    if Date() > deadline {
      Issue.record("timed out waiting for \(what())", sourceLocation: sourceLocation)
      throw E2EError("timed out waiting for \(what())")
    }
    try await Task.sleep(for: .milliseconds(20))
  }
}

/// Pairs over HTTP like the app does: the link from the QR code (its long
/// form of the code), or with `typed` the short code a user types plus the
/// computer's address.
@MainActor
func pairAndConnect(
  _ d: Daemon, factory: RecordingFactory = RecordingFactory(), name: String = "Swift e2e", typed: Bool = false
) async throws -> (PhoneCodeClient, HostCredentials, RecordingFactory) {
  let (code, link) = try await d.newPairCode()
  let parsed = try #require(PairingLink.parse(typed ? code : link))
  #expect(typed ? parsed.origin == nil : parsed.origin == d.url)
  let origin = parsed.origin ?? d.url
  let creds = try await PairingClient().pair(origin: origin, code: parsed.code, deviceName: name)
  let client = PhoneCodeClient(factory: factory)
  client.start(creds)
  try await waitUntil("connected") { client.status == .open && client.sessionsLoaded }
  return (client, creds, factory)
}

extension ChatState {
  var texts: [String] {
    allItems.compactMap { if case .text(let t) = $0 { t.text } else { nil } }
  }
  var lastTurn: TurnItem? {
    for i in allItems.reversed() { if case .turn(let t) = i { return t } }
    return nil
  }
  var turnCount: Int { allItems.filter { $0.kind == "turn" }.count }
  func first(_ kind: String) -> ChatItem? { allItems.first { $0.kind == kind } }
  func tools(_ name: String) -> [ToolItem] {
    allItems.compactMap { if case .tool(let t) = $0, t.name == name { t } else { nil } }
  }
}

/// 1x1 transparent PNG.
let tinyPNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
