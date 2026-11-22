import Foundation

// MARK: - Daemon -> client

public struct ReadyMessage: Sendable, Hashable {
  public var v: Int
  public var host: HostInfo
  public var deviceId: String
  public var vapidPublicKey: String?
}

/// One frame from the daemon, decoded in a single pass.
public enum ServerMessage: Sendable {
  case ready(ReadyMessage)
  case pong
  case error(code: String, message: String)
  /// `raw` is the whole frame, so the caller can decode `data` as the type the rpc expects.
  case res(id: String, ok: Bool, error: String?, raw: Data)
  case sessions([SessionInfo])
  case chatSnapshot(sessionId: String, seq: Int, items: [ChatItem])
  case chatItem(sessionId: String, seq: Int, item: ChatItem)
  case chatDelta(sessionId: String, seq: Int, itemId: String, text: String)
  case termSnapshot(sessionId: String, seq: Int, cols: Int, rows: Int, data: String)
  case termData(sessionId: String, seq: Int, data: String)
  case termExit(sessionId: String, exitCode: Int?)
  case unknown(t: String)

  private struct Frame: Decodable {
    let message: ServerMessage
    enum K: String, CodingKey {
      case t, v, host, deviceId, vapidPublicKey, code, message, id, ok, error, sessions
      case sessionId, seq, items, item, itemId, text, cols, rows, data, exitCode
    }
    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: K.self)
      let t = try c.decode(String.self, forKey: .t)
      switch t {
      case "ready":
        message = .ready(
          ReadyMessage(
            v: try c.decode(Int.self, forKey: .v), host: try c.decode(HostInfo.self, forKey: .host),
            deviceId: try c.decode(String.self, forKey: .deviceId),
            vapidPublicKey: try c.decodeIfPresent(String.self, forKey: .vapidPublicKey)))
      case "pong": message = .pong
      case "error":
        message = .error(
          code: (try? c.decode(String.self, forKey: .code)) ?? "internal",
          message: (try? c.decode(String.self, forKey: .message)) ?? "")
      case "res":
        message = .res(
          id: try c.decode(String.self, forKey: .id), ok: try c.decode(Bool.self, forKey: .ok),
          error: try c.decodeIfPresent(String.self, forKey: .error), raw: Data())
      case "sessions": message = .sessions(try c.decode([SessionInfo].self, forKey: .sessions))
      case "chat.snapshot":
        message = .chatSnapshot(
          sessionId: try c.decode(String.self, forKey: .sessionId), seq: try c.decode(Int.self, forKey: .seq),
          items: try c.decode([ChatItem].self, forKey: .items))
      case "chat.item":
        message = .chatItem(
          sessionId: try c.decode(String.self, forKey: .sessionId), seq: try c.decode(Int.self, forKey: .seq),
          item: try c.decode(ChatItem.self, forKey: .item))
      case "chat.delta":
        message = .chatDelta(
          sessionId: try c.decode(String.self, forKey: .sessionId), seq: try c.decode(Int.self, forKey: .seq),
          itemId: try c.decode(String.self, forKey: .itemId), text: try c.decode(String.self, forKey: .text))
      case "term.snapshot":
        message = .termSnapshot(
          sessionId: try c.decode(String.self, forKey: .sessionId), seq: try c.decode(Int.self, forKey: .seq),
          cols: try c.decode(Int.self, forKey: .cols), rows: try c.decode(Int.self, forKey: .rows),
          data: try c.decode(String.self, forKey: .data))
      case "term.data":
        message = .termData(
          sessionId: try c.decode(String.self, forKey: .sessionId), seq: try c.decode(Int.self, forKey: .seq),
          data: try c.decode(String.self, forKey: .data))
      case "term.exit":
        message = .termExit(
          sessionId: try c.decode(String.self, forKey: .sessionId),
          exitCode: try? c.decodeIfPresent(Int.self, forKey: .exitCode))
      default: message = .unknown(t: t)
      }
    }
  }

  /// Decodes one text frame. Returns nil for frames that are not protocol messages.
  public static func decode(_ data: Data, decoder: JSONDecoder = JSONDecoder()) -> ServerMessage? {
    guard let f = try? decoder.decode(Frame.self, from: data) else { return nil }
    if case .res(let id, let ok, let error, _) = f.message { return .res(id: id, ok: ok, error: error, raw: data) }
    return f.message
  }
}

/// `{"data": R}` out of a `res` frame.
struct ResData<R: Decodable>: Decodable {
  let data: R?
}

// MARK: - Client -> daemon

/// Requests that the daemon answers with `res`. The id is added when sent.
public enum RpcRequest: Sendable, Hashable {
  case sessionCreate(CreateSessionParams)
  case sessionRename(sessionId: String, title: String)
  case sessionDelete(sessionId: String)
  case fsList(path: String?)
  case historyList(agent: String?, query: HistoryQuery?)
  case sessionArchive(sessionId: String, archived: Bool)
  case sessionCommands(sessionId: String)
  case chatSend(sessionId: String, text: String, attachments: [Attachment]?)

  public var name: String {
    switch self {
    case .sessionCreate: "session.create"
    case .sessionRename: "session.rename"
    case .sessionDelete: "session.delete"
    case .fsList: "fs.list"
    case .historyList: "history.list"
    case .sessionArchive: "session.archive"
    case .sessionCommands: "session.commands"
    case .chatSend: "chat.send"
    }
  }
}

/// Fire-and-forget messages and the rpc envelope.
public enum ClientMessage: Sendable, Hashable, Encodable {
  case hello(token: String)
  case ping
  case rpc(id: String, RpcRequest)
  case sub(sessionId: String, afterSeq: Int?)
  case unsub(sessionId: String)
  case chatInterrupt(sessionId: String)
  case chatPermission(sessionId: String, itemId: String, decision: PermissionDecision, message: String?)
  case chatAnswer(sessionId: String, itemId: String, answers: [String: String])
  case chatSetMode(sessionId: String, mode: PermissionMode)
  case chatSetModel(sessionId: String, model: String)
  case chatSetEffort(sessionId: String, effort: String)
  case termInput(sessionId: String, data: String)
  case termResize(sessionId: String, cols: Int, rows: Int)

  private enum K: String, CodingKey {
    case t, v, token, id, params, sessionId, title, path, agent, query, archived, text, attachments
    case afterSeq, itemId, decision, message, answers, permissionMode, model, effort, data, cols, rows
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: K.self)
    switch self {
    case .hello(let token):
      try c.encode("hello", forKey: .t)
      try c.encode(protocolVersion, forKey: .v)
      try c.encode(token, forKey: .token)
    case .ping: try c.encode("ping", forKey: .t)
    case .rpc(let id, let req):
      try c.encode(req.name, forKey: .t)
      try c.encode(id, forKey: .id)
      switch req {
      case .sessionCreate(let p): try c.encode(p, forKey: .params)
      case .sessionRename(let s, let title):
        try c.encode(s, forKey: .sessionId)
        try c.encode(title, forKey: .title)
      case .sessionDelete(let s): try c.encode(s, forKey: .sessionId)
      case .fsList(let path): try c.encodeIfPresent(path, forKey: .path)
      case .historyList(let agent, let query):
        try c.encodeIfPresent(agent, forKey: .agent)
        try c.encodeIfPresent(query, forKey: .query)
      case .sessionArchive(let s, let archived):
        try c.encode(s, forKey: .sessionId)
        try c.encode(archived, forKey: .archived)
      case .sessionCommands(let s): try c.encode(s, forKey: .sessionId)
      case .chatSend(let s, let text, let attachments):
        try c.encode(s, forKey: .sessionId)
        try c.encode(text, forKey: .text)
        if let attachments, !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
      }
    case .sub(let s, let afterSeq):
      try c.encode("sub", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encodeIfPresent(afterSeq, forKey: .afterSeq)
    case .unsub(let s):
      try c.encode("unsub", forKey: .t)
      try c.encode(s, forKey: .sessionId)
    case .chatInterrupt(let s):
      try c.encode("chat.interrupt", forKey: .t)
      try c.encode(s, forKey: .sessionId)
    case .chatPermission(let s, let itemId, let decision, let message):
      try c.encode("chat.permission", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(itemId, forKey: .itemId)
      try c.encode(decision, forKey: .decision)
      try c.encodeIfPresent(message, forKey: .message)
    case .chatAnswer(let s, let itemId, let answers):
      try c.encode("chat.answer", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(itemId, forKey: .itemId)
      try c.encode(answers, forKey: .answers)
    case .chatSetMode(let s, let mode):
      try c.encode("chat.setMode", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(mode, forKey: .permissionMode)
    case .chatSetModel(let s, let model):
      try c.encode("chat.setModel", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(model, forKey: .model)
    case .chatSetEffort(let s, let effort):
      try c.encode("chat.setEffort", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(effort, forKey: .effort)
    case .termInput(let s, let data):
      try c.encode("term.input", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(data, forKey: .data)
    case .termResize(let s, let cols, let rows):
      try c.encode("term.resize", forKey: .t)
      try c.encode(s, forKey: .sessionId)
      try c.encode(cols, forKey: .cols)
      try c.encode(rows, forKey: .rows)
    }
  }

  var isPingOrHello: Bool {
    switch self {
    case .ping, .hello: true
    default: false
    }
  }

  var rpcId: String? {
    if case .rpc(let id, _) = self { return id }
    return nil
  }

  var isSubscription: Bool {
    switch self {
    case .sub, .unsub: true
    default: false
    }
  }
}
