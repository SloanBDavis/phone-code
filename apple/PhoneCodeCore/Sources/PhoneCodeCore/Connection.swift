import Foundation

public enum ConnectionStatus: Sendable, Equatable {
  case idle
  case connecting
  case open
  case reconnecting
  /// The daemon refused the token (unpaired or revoked on the computer).
  case unauthorized(String)
  /// The daemon speaks another protocol version.
  case incompatible(String)

  public var isOpen: Bool { self == .open }
}

public enum ConnectionEvent: Sendable {
  case status(ConnectionStatus)
  /// `ready`, `sessions`, chat and terminal events, already filtered by `seq`
  /// (a replayed or duplicate event never reaches the store twice).
  case message(ServerMessage)
}

public struct RpcError: Error, Sendable, Equatable, CustomStringConvertible {
  public var message: String
  public init(_ message: String) { self.message = message }
  public var description: String { message }
}

/// The protocol client below the store: one WebSocket with `hello`, pings,
/// jittered exponential backoff, resubscription with `afterSeq`, rpc with ids
/// and timeouts, and an outbox while disconnected. Everything is decoded on
/// this actor, off the main thread. Commands (`send`, `rpc`, `subscribe`) are
/// queued in call order, so a `sub` followed by a `chat.send` arrives in that order.
public actor Connection {
  public struct Options: Sendable {
    public var pingInterval: Double = 15
    public var deadAfter: Double = 40
    public var rpcTimeout: Double = 20
    public var backoffMin: Double = 0.5
    public var backoffMax: Double = 15
    public init() {}
  }

  private enum Op: Sendable {
    case send(ClientMessage)
    case rpc(RpcRequest, Double, CheckedContinuation<Data, Error>)
    case sub(String)
    case unsub(String)
    case forgetSeq(String)
    case retryNow
    case probe
    case stop
  }

  public nonisolated let events: AsyncStream<ConnectionEvent>
  private nonisolated let eventSink: AsyncStream<ConnectionEvent>.Continuation
  private nonisolated let ops: AsyncStream<Op>.Continuation
  private let opStream: AsyncStream<Op>

  private let url: URL
  private let token: String
  private let factory: WebSocketFactory
  private let options: Options
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  private var ws: WebSocket?
  private var ready = false
  private var stopped = true
  private var everOpened = false
  private var attempt = 0
  private var lastSeen = Date()
  private var outbox: [ClientMessage] = []
  private var pending: [String: CheckedContinuation<Data, Error>] = [:]
  private var subs: Set<String> = []
  private var seqs: [String: Int] = [:]
  private var counter = 0
  private var runTask: Task<Void, Never>?
  private var opTask: Task<Void, Never>?
  private var pingTask: Task<Void, Never>?
  private var sleeper: Task<Void, Never>?
  private var status: ConnectionStatus = .idle

  /// `baseURL` is the daemon's http(s) origin, e.g. `https://mac.tailnet.ts.net`.
  public init(baseURL: URL, token: String, factory: WebSocketFactory = WebSockets.platformDefault, options: Options = Options()) {
    var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) ?? URLComponents()
    c.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    c.path = "/ws"
    c.query = nil
    c.fragment = nil
    self.url = c.url ?? baseURL
    self.token = token
    self.factory = factory
    self.options = options
    (events, eventSink) = AsyncStream.makeStream(of: ConnectionEvent.self)
    let (stream, cont) = AsyncStream.makeStream(of: Op.self)
    self.opStream = stream
    self.ops = cont
  }

  // MARK: public API (nonisolated: queued in call order)

  public func start() {
    guard stopped, opTask == nil || runTask == nil else { return }
    stopped = false
    if opTask == nil {
      let stream = opStream
      opTask = Task { [weak self] in
        for await op in stream {
          guard let self else { return }
          await self.perform(op)
        }
      }
    }
    runTask = Task { [weak self] in await self?.run() }
  }

  public nonisolated func stop() { ops.yield(.stop) }
  public nonisolated func send(_ msg: ClientMessage) { ops.yield(.send(msg)) }
  public nonisolated func subscribe(_ sessionId: String) { ops.yield(.sub(sessionId)) }
  public nonisolated func unsubscribe(_ sessionId: String) { ops.yield(.unsub(sessionId)) }
  /// The next `sub` asks for a full snapshot (a fresh terminal view needs one).
  public nonisolated func forgetSeq(_ sessionId: String) { ops.yield(.forgetSeq(sessionId)) }
  /// Reconnect now (app came to the foreground, network came back).
  public nonisolated func retryNow() { ops.yield(.retryNow) }
  /// Checks a link that may have died in the background: ping, and drop it if nothing answers.
  public nonisolated func probe() { ops.yield(.probe) }

  /// An rpc; the raw `res` frame on success.
  public nonisolated func rpcRaw(_ req: RpcRequest, timeout: Double? = nil) async throws -> Data {
    try await withCheckedThrowingContinuation { c in
      ops.yield(.rpc(req, timeout ?? 20, c))
    }
  }

  /// An rpc whose `data` decodes as `R`.
  public nonisolated func rpc<R: Decodable & Sendable>(_ req: RpcRequest, as: R.Type = R.self, timeout: Double? = nil) async throws -> R {
    let raw = try await rpcRaw(req, timeout: timeout)
    let d = try JSONDecoder().decode(ResData<R>.self, from: raw)
    guard let data = d.data else { throw RpcError("Unexpected answer from your computer") }
    return data
  }

  /// An rpc whose result is ignored.
  public nonisolated func rpcVoid(_ req: RpcRequest, timeout: Double? = nil) async throws {
    _ = try await rpcRaw(req, timeout: timeout)
  }

  public func lastSeq(_ sessionId: String) -> Int? { seqs[sessionId] }
  public func currentStatus() -> ConnectionStatus { status }

  // MARK: ops

  private func perform(_ op: Op) async {
    switch op {
    case .send(let m): await sendOrQueue(m)
    case .rpc(let req, let timeout, let c):
      counter += 1
      let id = "r\(counter)-\(UInt32.random(in: 0...UInt32.max))"
      pending[id] = c
      let t = timeout
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(t))
        await self?.timeoutRpc(id)
      }
      await sendOrQueue(.rpc(id: id, req))
    case .sub(let s):
      subs.insert(s)
      await sendOrQueue(.sub(sessionId: s, afterSeq: seqs[s]))
    case .unsub(let s):
      subs.remove(s)
      await sendOrQueue(.unsub(sessionId: s))
    case .forgetSeq(let s): seqs[s] = nil
    case .retryNow:
      guard !stopped else { return }
      attempt = 0
      if !ready { sleeper?.cancel() }
    case .probe:
      guard ready, let ws else { return }
      let probeAt = Date()
      await raw(.ping, on: ws)
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(4))
        await self?.checkProbe(since: probeAt, ws: ws)
      }
    case .stop:
      stopped = true
      sleeper?.cancel()
      pingTask?.cancel()
      ws?.close(code: 1000)
      ws = nil
      ready = false
      runTask?.cancel()
      runTask = nil
      for (_, c) in pending { c.resume(throwing: RpcError("Disconnected")) }
      pending = [:]
      outbox = []
      subs = []
      seqs = [:]
      setStatus(.idle)
    }
  }

  private func checkProbe(since: Date, ws probed: WebSocket) {
    if lastSeen < since, probed === ws { probed.close(code: 4000) }
  }

  private func timeoutRpc(_ id: String) {
    guard let c = pending.removeValue(forKey: id) else { return }
    outbox.removeAll { $0.rpcId == id }
    c.resume(throwing: RpcError("The host did not answer in time"))
  }

  private func sendOrQueue(_ m: ClientMessage) async {
    if ready, let ws {
      await raw(m, on: ws)
    } else if !m.isPingOrHello {
      outbox.append(m)
    }
  }

  private func raw(_ m: ClientMessage, on ws: WebSocket) async {
    guard let d = try? encoder.encode(m) else { return }
    do { try await ws.send(String(decoding: d, as: UTF8.self)) } catch {
      // The read loop notices the dead socket and reconnects; keep the message.
      if !m.isPingOrHello { outbox.append(m) }
    }
  }

  private func setStatus(_ s: ConnectionStatus) {
    guard s != status else { return }
    status = s
    eventSink.yield(.status(s))
  }

  // MARK: connection loop

  private func run() async {
    while !stopped {
      setStatus(everOpened ? .reconnecting : .connecting)
      var closeCode: Int?
      do {
        let socket = try await factory.connect(to: url)
        if stopped {
          socket.close(code: 1000)
          return
        }
        ws = socket
        lastSeen = Date()
        await raw(.hello(token: token), on: socket)
        while !stopped {
          let frame = try await socket.receive()
          guard ws === socket else { break }
          lastSeen = Date()
          await handle(frame)
        }
      } catch let e as WebSocketClosed {
        closeCode = e.code
      } catch {}
      ready = false
      pingTask?.cancel()
      ws = nil
      if closeCode == 4401 {
        stopped = true
        setStatus(.unauthorized("This device was unpaired on your computer."))
      } else if closeCode == 4400 {
        stopped = true
        setStatus(.incompatible("Your computer runs a different phone-code version."))
      }
      if stopped { break }
      setStatus(everOpened ? .reconnecting : .connecting)
      let base = min(options.backoffMax, options.backoffMin * pow(2, Double(attempt)))
      attempt += 1
      let delay = base / 2 + Double.random(in: 0...(base / 2))
      let s = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
      sleeper = s
      await s.value
    }
  }

  private func startPing(_ socket: WebSocket) {
    pingTask?.cancel()
    let every = options.pingInterval
    pingTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(every))
        if Task.isCancelled { return }
        await self?.pingTick(socket)
      }
    }
  }

  private func pingTick(_ socket: WebSocket) async {
    guard socket === ws else { return }
    if Date().timeIntervalSince(lastSeen) > options.deadAfter {
      socket.close(code: 4000)
      return
    }
    await raw(.ping, on: socket)
  }

  private func fresh(_ sessionId: String, _ seq: Int) -> Bool {
    if let last = seqs[sessionId], seq <= last { return false }
    seqs[sessionId] = seq
    return true
  }

  private func handle(_ frame: Data) async {
    guard let msg = ServerMessage.decode(frame, decoder: decoder) else { return }
    switch msg {
    case .pong, .unknown: return
    case .ready:
      ready = true
      everOpened = true
      attempt = 0
      if let ws { startPing(ws) }
      eventSink.yield(.message(msg))
      setStatus(.open)
      let out = outbox
      outbox = []
      // Subscriptions first, so queued sends land in a subscribed session.
      for s in subs.sorted() { await sendOrQueue(.sub(sessionId: s, afterSeq: seqs[s])) }
      for m in out where !m.isSubscription { await sendOrQueue(m) }
    case .error(let code, let message):
      if code == "unauthorized" {
        stopped = true
        setStatus(.unauthorized(message.isEmpty ? "This device was unpaired on your computer." : message))
        ws?.close(code: 1000)
      } else if code == "version" {
        stopped = true
        setStatus(.incompatible(message))
        ws?.close(code: 1000)
      }
    case .res(let id, let ok, let error, let raw):
      guard let c = pending.removeValue(forKey: id) else { return }
      if ok { c.resume(returning: raw) } else { c.resume(throwing: RpcError(error ?? "Request failed")) }
    case .sessions: eventSink.yield(.message(msg))
    case .chatSnapshot(let s, let seq, _), .termSnapshot(let s, let seq, _, _, _):
      seqs[s] = seq
      eventSink.yield(.message(msg))
    case .chatItem(let s, let seq, _), .chatDelta(let s, let seq, _, _), .termData(let s, let seq, _):
      if fresh(s, seq) { eventSink.yield(.message(msg)) }
    case .termExit: eventSink.yield(.message(msg))
    }
  }
}
