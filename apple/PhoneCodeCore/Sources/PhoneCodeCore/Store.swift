import Foundation
import Observation

/// One transcript item behind its own observable box, so a streaming delta
/// invalidates exactly one row and never the whole transcript.
@MainActor @Observable
public final class ItemBox: Identifiable {
  public let id: String
  public internal(set) var item: ChatItem
  init(_ item: ChatItem) {
    self.id = item.id
    self.item = item
  }
}

/// A message the user sent that the daemon has not echoed back yet.
public struct PendingSend: Identifiable, Hashable, Sendable {
  public enum Status: Sendable, Hashable { case sending, failed }
  public var id: String { localId }
  public var localId: String
  public var text: String
  public var attachments: [Attachment]
  public var ts: Double
  public var status: Status
  /// The daemon's item id, once it acknowledged the send.
  public var awaitId: String?
  public var error: String?
}

/// One chat's transcript. Top-level ids in order (sub-agent calls are under
/// `children` of their Task), pending asks, and optimistic sends.
@MainActor @Observable
public final class ChatState {
  public let sessionId: String
  public internal(set) var ids: [String] = []
  /// Task tool id -> ids of its nested calls.
  public internal(set) var children: [String: [String]] = [:]
  /// Permission and question items still waiting for the user.
  public internal(set) var asks: [String] = []
  public internal(set) var loaded = false
  public internal(set) var pending: [PendingSend] = []
  @ObservationIgnored var boxes: [String: ItemBox] = [:]

  init(sessionId: String) { self.sessionId = sessionId }

  public func box(_ id: String) -> ItemBox? { boxes[id] }
  public func item(_ id: String) -> ChatItem? { boxes[id]?.item }
  public var count: Int { boxes.count }

  /// All items in transcript order, children after their parent (for tests and search).
  public var allItems: [ChatItem] {
    var out: [ChatItem] = []
    func add(_ id: String) {
      guard let b = boxes[id] else { return }
      out.append(b.item)
      for c in children[id] ?? [] { add(c) }
    }
    for id in ids { add(id) }
    return out
  }

  /// How full the model's context is, as of the last turn that reported it.
  public var context: (tokens: Double, window: Double)? {
    for id in ids.reversed() {
      if case .turn(let t) = boxes[id]?.item, let used = t.contextTokens, let window = t.contextWindow, used > 0, window > 0 {
        return (used, window)
      }
    }
    return nil
  }

  /// The text of the last assistant message (for "Copy last response").
  public var lastResponse: String? {
    for id in ids.reversed() {
      if case .text(let t) = boxes[id]?.item, !t.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return t.text
      }
    }
    return nil
  }

  func reset(_ items: [ChatItem]) {
    var newBoxes: [String: ItemBox] = [:]
    var top: [String] = []
    var kids: [String: [String]] = [:]
    var newAsks: [String] = []
    for item in items {
      // Keep existing boxes so rows that did not change are not rebuilt.
      if let b = boxes[item.id] {
        if b.item != item { b.item = item }
        newBoxes[item.id] = b
      } else {
        newBoxes[item.id] = ItemBox(item)
      }
      if let p = item.parentId { kids[p, default: []].append(item.id) } else { top.append(item.id) }
      if item.isPendingAsk { newAsks.append(item.id) }
    }
    boxes = newBoxes
    if ids != top { ids = top }
    if children != kids { children = kids }
    if asks != newAsks { asks = newAsks }
    loaded = true
    let known = Set(items.map(\.id))
    let left = pending.filter { p in !(p.awaitId.map(known.contains) ?? false) }
    if left != pending { pending = left }
  }

  func upsert(_ item: ChatItem) {
    if let b = boxes[item.id] {
      let from = b.item.parentId
      let to = item.parentId
      b.item = item
      if from != to {
        if let from { children[from]?.removeAll { $0 == item.id } } else { ids.removeAll { $0 == item.id } }
        if let to { children[to, default: []].append(item.id) } else { ids.append(item.id) }
      }
    } else {
      boxes[item.id] = ItemBox(item)
      if let p = item.parentId { children[p, default: []].append(item.id) } else { ids.append(item.id) }
      if case .user = item, pending.contains(where: { $0.awaitId == item.id }) {
        pending.removeAll { $0.awaitId == item.id }
      }
    }
    let has = asks.contains(item.id)
    if item.isPendingAsk, !has { asks.append(item.id) } else if !item.isPendingAsk, has { asks.removeAll { $0 == item.id } }
  }

  func append(_ itemId: String, _ text: String) {
    guard let b = boxes[itemId], let next = b.item.appending(text) else { return }
    b.item = next
  }
}

/// Receives a terminal session's output (SwiftTerm's view in the app).
@MainActor
public protocol TerminalSink: AnyObject {
  func terminalSnapshot(data: String, cols: Int, rows: Int)
  func terminalData(_ data: String)
  func terminalExit(code: Int?)
}

/// What a paired device needs to reach its host.
public struct HostCredentials: Codable, Hashable, Sendable {
  public var baseURL: URL
  public var token: String
  public var deviceId: String
  public var hostName: String
  public var pairedAt: Double
  public init(baseURL: URL, token: String, deviceId: String, hostName: String, pairedAt: Double = Date().timeIntervalSince1970 * 1000) {
    self.baseURL = baseURL
    self.token = token
    self.deviceId = deviceId
    self.hostName = hostName
    self.pairedAt = pairedAt
  }
}

/// The app's model of one host: connection state, the session list, and a
/// `ChatState` per open chat. Main-actor; frames are decoded on the
/// `Connection` actor and applied here.
@MainActor @Observable
public final class PhoneCodeClient {
  public private(set) var status: ConnectionStatus = .idle
  public private(set) var host: HostInfo?
  public private(set) var deviceId: String?
  public private(set) var sessions: [SessionInfo] = []
  public private(set) var sessionsLoaded = false
  /// The first message of a new chat while its session is being created.
  public private(set) var starting: PendingSend?

  @ObservationIgnored public private(set) var credentials: HostCredentials?
  @ObservationIgnored private var connection: Connection?
  @ObservationIgnored private var pump: Task<Void, Never>?
  @ObservationIgnored private var chats: [String: ChatState] = [:]
  @ObservationIgnored private var subCounts: [String: Int] = [:]
  @ObservationIgnored private var terminals: [String: [ObjectIdentifier: WeakSink]] = [:]
  @ObservationIgnored private var justCreated: [String: SessionInfo] = [:]
  @ObservationIgnored private let factory: WebSocketFactory
  @ObservationIgnored private var counter = 0
  /// Called on every session list the daemon sends (attention tracking, notifications).
  @ObservationIgnored public var onSessions: (([SessionInfo]) -> Void)?
  /// Called when the daemon refuses this device (unpaired or revoked).
  @ObservationIgnored public var onUnauthorized: ((String) -> Void)?

  private struct WeakSink {
    weak var sink: TerminalSink?
  }

  public init(factory: WebSocketFactory = WebSockets.platformDefault) {
    self.factory = factory
  }

  // MARK: lifecycle

  public func start(_ creds: HostCredentials, options: Connection.Options = Connection.Options()) {
    stop()
    credentials = creds
    let c = Connection(baseURL: creds.baseURL, token: creds.token, factory: factory, options: options)
    connection = c
    let events = c.events
    pump = Task { [weak self] in
      for await ev in events {
        guard let self else { return }
        self.apply(ev)
      }
    }
    Task { await c.start() }
  }

  public func stop() {
    connection?.stop()
    connection = nil
    pump?.cancel()
    pump = nil
    credentials = nil
    status = .idle
    host = nil
    deviceId = nil
    sessions = []
    sessionsLoaded = false
    starting = nil
    chats = [:]
    subCounts = [:]
    justCreated = [:]
  }

  public func retryNow() { connection?.retryNow() }
  /// After returning from the background: make sure the socket is still alive.
  public func probe() {
    if status == .open { connection?.probe() } else { connection?.retryNow() }
  }

  // MARK: state

  public func chat(_ sessionId: String) -> ChatState {
    if let c = chats[sessionId] { return c }
    let c = ChatState(sessionId: sessionId)
    chats[sessionId] = c
    return c
  }

  public func session(_ id: String) -> SessionInfo? { sessions.first { $0.id == id } }

  /// Sidebar order: sessions that need the user first, then every other chat
  /// (whatever harness it is, Cursor's app included); archived hidden.
  public var sidebar: (needsYou: [SessionInfo], chats: [SessionInfo]) {
    let shown = sessions.filter { !$0.isArchived }
    return (shown.filter { $0.status == .waiting }, shown.filter { $0.status != .waiting })
  }

  public var agents: [AgentInfo] { Agents.catalog(host) }

  private func apply(_ ev: ConnectionEvent) {
    switch ev {
    case .status(let s):
      status = s
      if case .unauthorized(let why) = s { onUnauthorized?(why) }
    case .message(let m):
      switch m {
      case .ready(let r):
        host = r.host
        deviceId = r.deviceId
      case .sessions(let list):
        applySessions(list)
        sessionsLoaded = true
        onSessions?(sessions)
      case .chatSnapshot(let s, _, let items): chat(s).reset(items)
      case .chatItem(let s, _, let item): chat(s).upsert(item)
      case .chatDelta(let s, _, let itemId, let text): chat(s).append(itemId, text)
      case .termSnapshot(let s, _, let cols, let rows, let data):
        for w in terminals[s]?.values ?? [:].values { w.sink?.terminalSnapshot(data: data, cols: cols, rows: rows) }
      case .termData(let s, _, let data):
        for w in terminals[s]?.values ?? [:].values { w.sink?.terminalData(data) }
      case .termExit(let s, let code):
        for w in terminals[s]?.values ?? [:].values { w.sink?.terminalExit(code: code) }
      default: break
      }
    }
  }

  /// The daemon's list, plus a session this device just created that the list does not show yet (for 15 s).
  private func applySessions(_ list: [SessionInfo]) {
    let now = Date().timeIntervalSince1970 * 1000
    var extra: [SessionInfo] = []
    for (id, s) in justCreated {
      if list.contains(where: { $0.id == id }) || now - s.createdAt > 15_000 { justCreated[id] = nil } else { extra.append(s) }
    }
    var next = extra + list
    // Keep a local archive flip until the daemon agrees (instant swipe).
    for (id, archived) in localArchive {
      if let i = next.firstIndex(where: { $0.id == id }) {
        if next[i].isArchived == archived { localArchive[id] = nil } else { next[i].archived = archived ? true : nil }
      }
    }
    if next != sessions { sessions = next }
  }

  @ObservationIgnored private var localArchive: [String: Bool] = [:]

  private func remember(_ s: SessionInfo) {
    var s = s
    s.createdAt = Date().timeIntervalSince1970 * 1000
    justCreated[s.id] = s
    if !sessions.contains(where: { $0.id == s.id }) { sessions.insert(s, at: 0) }
  }

  // MARK: subscriptions

  /// Ref-counted subscription; call `unsubscribe` as often as `subscribe`.
  public func subscribe(_ sessionId: String) {
    let n = subCounts[sessionId, default: 0]
    subCounts[sessionId] = n + 1
    if n == 0 { connection?.subscribe(sessionId) }
  }

  public func unsubscribe(_ sessionId: String) {
    let left = subCounts[sessionId, default: 1] - 1
    if left > 0 {
      subCounts[sessionId] = left
      return
    }
    subCounts[sessionId] = nil
    connection?.unsubscribe(sessionId)
  }

  public func isSubscribed(_ sessionId: String) -> Bool { subCounts[sessionId] != nil }

  /// Attach a terminal view. The first one asks for a full snapshot.
  public func attachTerminal(_ sessionId: String, _ sink: TerminalSink) {
    var set = terminals[sessionId] ?? [:]
    set[ObjectIdentifier(sink)] = WeakSink(sink: sink)
    terminals[sessionId] = set
    connection?.forgetSeq(sessionId)
    subscribe(sessionId)
  }

  public func detachTerminal(_ sessionId: String, _ sink: TerminalSink) {
    terminals[sessionId]?[ObjectIdentifier(sink)] = nil
    if terminals[sessionId]?.isEmpty == true { terminals[sessionId] = nil }
    unsubscribe(sessionId)
  }

  // MARK: rpc helpers

  private func conn() throws -> Connection {
    guard let connection else { throw RpcError("Not connected") }
    return connection
  }

  public func send(_ msg: ClientMessage) { connection?.send(msg) }

  @discardableResult
  public func createSession(_ params: CreateSessionParams) async throws -> SessionInfo {
    let s = try await conn().rpc(.sessionCreate(params), as: SessionInfo.self)
    remember(s)
    return s
  }

  public func rename(_ sessionId: String, title: String) async throws {
    _ = try await conn().rpc(.sessionRename(sessionId: sessionId, title: title), as: SessionInfo.self)
  }

  public func delete(_ sessionId: String) async throws {
    try await conn().rpcVoid(.sessionDelete(sessionId: sessionId))
    chats[sessionId] = nil
    sessions.removeAll { $0.id == sessionId }
  }

  /// Instant: the row leaves the sidebar now; reverts if the daemon refuses.
  public func archive(_ sessionId: String, _ archived: Bool = true) async throws {
    setArchivedLocally(sessionId, archived)
    do {
      _ = try await conn().rpc(.sessionArchive(sessionId: sessionId, archived: archived), as: SessionInfo.self)
    } catch {
      setArchivedLocally(sessionId, !archived)
      localArchive[sessionId] = nil
      throw error
    }
  }

  private func setArchivedLocally(_ id: String, _ archived: Bool) {
    localArchive[id] = archived
    if let i = sessions.firstIndex(where: { $0.id == id }) { sessions[i].archived = archived ? true : nil }
  }

  public func history(_ query: HistoryQuery = HistoryQuery(), agent: String? = nil) async throws -> [ResumableSession] {
    try await conn().rpc(.historyList(agent: agent, query: query), as: [ResumableSession].self)
  }

  public func commands(_ sessionId: String) async throws -> [SlashCommand] {
    try await conn().rpc(.sessionCommands(sessionId: sessionId), as: [SlashCommand].self)
  }

  /// Installs phone-code's hooks in Cursor (or removes them); the host's status follows.
  @discardableResult
  public func setCursorConnected(_ on: Bool) async throws -> CursorStatus {
    let status = try await conn().rpc(on ? .cursorConnect : .cursorDisconnect, as: CursorStatus.self)
    host?.cursor = status
    return status
  }

  public func listFolder(_ path: String?) async throws -> FsListResult {
    try await conn().rpc(.fsList(path: path), as: FsListResult.self)
  }

  public func interrupt(_ sessionId: String) { send(.chatInterrupt(sessionId: sessionId)) }

  public func answerPermission(_ sessionId: String, itemId: String, _ decision: PermissionDecision, message: String? = nil) {
    send(.chatPermission(sessionId: sessionId, itemId: itemId, decision: decision, message: message))
  }

  public func answerQuestion(_ sessionId: String, itemId: String, answers: [String: String]) {
    send(.chatAnswer(sessionId: sessionId, itemId: itemId, answers: answers))
  }

  public func setMode(_ sessionId: String, _ mode: PermissionMode) { send(.chatSetMode(sessionId: sessionId, mode: mode)) }
  public func setModel(_ sessionId: String, _ model: String) { send(.chatSetModel(sessionId: sessionId, model: model)) }
  public func setEffort(_ sessionId: String, _ effort: String) { send(.chatSetEffort(sessionId: sessionId, effort: effort)) }
  public func terminalInput(_ sessionId: String, _ data: String) { send(.termInput(sessionId: sessionId, data: data)) }
  public func terminalResize(_ sessionId: String, cols: Int, rows: Int) {
    send(.termResize(sessionId: sessionId, cols: cols, rows: rows))
  }

  private func localId() -> String {
    counter += 1
    return "local\(counter)-\(UInt32.random(in: 0...UInt32.max))"
  }

  // MARK: sending

  /// Optimistic send: the bubble shows at once and settles when the daemon echoes it.
  public func sendChat(_ sessionId: String, text: String, attachments: [Attachment] = []) async {
    let c = chat(sessionId)
    let id = localId()
    c.pending.append(
      PendingSend(localId: id, text: text, attachments: attachments, ts: Date().timeIntervalSince1970 * 1000, status: .sending))
    do {
      let res = try await conn().rpc(
        .chatSend(sessionId: sessionId, text: text, attachments: attachments.isEmpty ? nil : attachments),
        as: SendResult.self, timeout: attachments.isEmpty ? nil : 120)
      if c.boxes[res.itemId] != nil {
        c.pending.removeAll { $0.localId == id }
      } else if let i = c.pending.firstIndex(where: { $0.localId == id }) {
        c.pending[i].awaitId = res.itemId
      }
    } catch {
      if let i = c.pending.firstIndex(where: { $0.localId == id }) {
        c.pending[i].status = .failed
        c.pending[i].error = "\(error)"
      }
    }
  }

  public func retrySend(_ sessionId: String, localId: String) async {
    let c = chat(sessionId)
    guard let p = c.pending.first(where: { $0.localId == localId }) else { return }
    c.pending.removeAll { $0.localId == localId }
    await sendChat(sessionId, text: p.text, attachments: p.attachments)
  }

  public func discardPending(_ sessionId: String, localId: String) {
    chat(sessionId).pending.removeAll { $0.localId == localId }
  }

  /// First send in a new chat: creates the session with the composer's
  /// choices, then sends the message into it. Returns the new session.
  @discardableResult
  public func startChat(_ draft: NewChatChoices, text: String, attachments: [Attachment] = []) async throws -> SessionInfo {
    let p = PendingSend(
      localId: localId(), text: text, attachments: attachments, ts: Date().timeIntervalSince1970 * 1000, status: .sending)
    starting = p
    do {
      let s = try await createSession(
        CreateSessionParams(
          kind: .agent, agent: draft.harness, cwd: draft.cwd, model: draft.model, effort: draft.effort,
          permissionMode: draft.mode))
      starting = nil
      Task { await self.sendChat(s.id, text: text, attachments: attachments) }
      return s
    } catch {
      if starting?.localId == p.localId {
        var f = p
        f.status = .failed
        f.error = "\(error)"
        starting = f
      }
      throw error
    }
  }

  public func clearStarting() { starting = nil }

  /// Open a conversation found by search: an existing session, or resume it as a new one.
  public func open(_ r: ResumableSession) async throws -> String {
    if let id = r.sessionId {
      if session(id)?.isArchived == true || r.archived == true { try? await archive(id, false) }
      return id
    }
    let s = try await createSession(CreateSessionParams(kind: .agent, agent: r.agent, cwd: r.cwd, title: r.title, resumeId: r.resumeId))
    return s.id
  }

  /// A terminal in `cwd`, sized for the view that will show it.
  public func openTerminal(cwd: String, cols: Int, rows: Int) async throws -> SessionInfo {
    try await createSession(CreateSessionParams(kind: .terminal, cwd: cwd, cols: cols, rows: rows))
  }
}
