import Foundation

// Mirrors packages/protocol/src/index.ts (protocol v1). Every enum-like string
// is an `OpenEnum` and every union has an `unknown` case, so a newer daemon
// never makes this app fail to decode a frame.

public let protocolVersion = 1

// MARK: - Sessions

public struct SessionKind: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let terminal: Self = "terminal"
  public static let agent: Self = "agent"
}

public struct AgentImpl: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let native: Self = "native"
  public static let acp: Self = "acp"
}

public struct SessionStatus: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let idle: Self = "idle"
  public static let running: Self = "running"
  public static let waiting: Self = "waiting"
  public static let exited: Self = "exited"
  public static let error: Self = "error"
}

public struct PermissionMode: OpenEnum, Identifiable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public var id: String { rawValue }
  public static let `default`: Self = "default"
  public static let acceptEdits: Self = "acceptEdits"
  public static let plan: Self = "plan"
  public static let auto: Self = "auto"
  public static let bypassPermissions: Self = "bypassPermissions"
  /// The modes every agent had before `auto`; offered when an agent lists none.
  public static let classic: [Self] = [.default, .acceptEdits, .plan, .bypassPermissions]

  /// Same wording as the web app's mode picker (screens/chat/pickers.tsx).
  public var label: String {
    switch self {
    case .default: "Ask before acting"
    case .acceptEdits: "Accept edits"
    case .plan: "Plan only"
    case .auto: "Auto"
    case .bypassPermissions: "Bypass permissions"
    default: rawValue
    }
  }

  public var shortLabel: String {
    switch self {
    case .default: "Ask"
    case .acceptEdits: "Edits"
    case .plan: "Plan"
    case .auto: "Auto"
    case .bypassPermissions: "Bypass"
    default: rawValue
    }
  }

  public var hint: String {
    switch self {
    case .default: "Approve edits and commands"
    case .acceptEdits: "Edits apply, commands still ask"
    case .plan: "Read and plan, change nothing"
    case .auto: "Claude approves safe actions, asks for risky ones"
    case .bypassPermissions: "Never ask. Use with care"
    default: ""
    }
  }

  /// SF Symbol for the mode.
  public var symbol: String {
    switch self {
    case .default: "checkmark.shield"
    case .acceptEdits: "pencil"
    case .plan: "list.bullet"
    case .auto: "shield.lefthalf.filled"
    case .bypassPermissions: "bolt"
    default: "questionmark.circle"
    }
  }
}

public struct ModelOption: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String?
  public var description: String?
  public var resolved: String?
  public var isDefault: Bool?
  public init(id: String, name: String? = nil, description: String? = nil, resolved: String? = nil, isDefault: Bool? = nil) {
    self.id = id
    self.name = name
    self.description = description
    self.resolved = resolved
    self.isDefault = isDefault
  }
}

public struct SlashCommand: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var description: String?
  public var argumentHint: String?
  public var source: String?
  public var id: String { name }
}

public struct AgentInfo: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var impl: AgentImpl
  public var available: Bool
  public var version: String?
  public var models: [String]?
  public var modelOptions: [ModelOption]?
  public var permissionModes: [PermissionMode]?
  public var source: String?
  public var setupHint: String?
  public var commands: [SlashCommand]?
}

public struct SessionInfo: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var kind: SessionKind
  public var agent: String?
  public var agentName: String?
  public var title: String
  public var cwd: String
  public var createdAt: Double
  public var updatedAt: Double
  public var status: SessionStatus
  public var preview: String?
  public var model: String?
  public var permissionMode: PermissionMode?
  public var permissionModes: [PermissionMode]?
  public var models: [String]?
  public var modelOptions: [ModelOption]?
  public var unread: Bool?
  public var archived: Bool?

  public var isArchived: Bool { archived == true }
  public var isUnread: Bool { unread == true }
  public var isTerminal: Bool { kind == .terminal }
}

public struct ConnectionInfo: Codable, Hashable, Sendable {
  public var mode: String
  public var secure: Bool
}

public struct HostAgent: Codable, Hashable, Sendable {
  public var kind: String
  public var available: Bool
  public var version: String?
  public var models: [String]?
}

public struct HostInfo: Codable, Hashable, Sendable {
  public var name: String
  public var platform: String
  public var user: String
  public var home: String
  public var daemonVersion: String
  public var agents: [HostAgent]
  public var agentCatalog: [AgentInfo]?
  public var shell: String
  public var connection: ConnectionInfo?
}

// MARK: - Chat items

public struct ImageRef: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var mediaType: String
  public var name: String?
  public var width: Double?
  public var height: Double?
  public var bytes: Double?
}

/// An image sent with a message: base64 without the `data:` prefix.
public struct Attachment: Codable, Hashable, Sendable {
  public var mediaType: String
  public var name: String?
  public var data: String
  public init(mediaType: String, name: String? = nil, data: String) {
    self.mediaType = mediaType
    self.name = name
    self.data = data
  }
}

public struct UserItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  public var text: String
  public var images: [ImageRef]?
}

public struct TextItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  public var text: String
  public var streaming: Bool
  public var images: [ImageRef]?
}

public struct ThinkingItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  public var text: String
  public var streaming: Bool
}

public struct ToolStatus: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let running: Self = "running"
  public static let done: Self = "done"
  public static let error: Self = "error"
  public static let denied: Self = "denied"
}

public struct TodoEntry: Codable, Hashable, Sendable {
  public var text: String
  public var status: String
}

public enum ToolDetail: Codable, Hashable, Sendable {
  case command(command: String, cwd: String?, exitCode: Int?)
  case diff(path: String, patch: String, added: Int, removed: Int)
  case file(path: String, content: String?)
  case todos([TodoEntry])
  case search(query: String, path: String?)
  case url(String)
  case unknown(type: String)

  private enum K: String, CodingKey { case type, command, cwd, exitCode, path, patch, added, removed, content, todos, query, url }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    let type = (try? c.decode(String.self, forKey: .type)) ?? ""
    do {
      switch type {
      case "command":
        self = .command(
          command: try c.decode(String.self, forKey: .command),
          cwd: try c.decodeIfPresent(String.self, forKey: .cwd),
          exitCode: try? c.decodeIfPresent(Int.self, forKey: .exitCode))
      case "diff":
        self = .diff(
          path: try c.decode(String.self, forKey: .path), patch: try c.decode(String.self, forKey: .patch),
          added: (try? c.decode(Int.self, forKey: .added)) ?? 0,
          removed: (try? c.decode(Int.self, forKey: .removed)) ?? 0)
      case "file":
        self = .file(path: try c.decode(String.self, forKey: .path), content: try c.decodeIfPresent(String.self, forKey: .content))
      case "todos": self = .todos(try c.decode([TodoEntry].self, forKey: .todos))
      case "search":
        self = .search(query: try c.decode(String.self, forKey: .query), path: try c.decodeIfPresent(String.self, forKey: .path))
      case "url": self = .url(try c.decode(String.self, forKey: .url))
      default: self = .unknown(type: type)
      }
    } catch {
      self = .unknown(type: type)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: K.self)
    switch self {
    case .command(let command, let cwd, let exitCode):
      try c.encode("command", forKey: .type)
      try c.encode(command, forKey: .command)
      try c.encodeIfPresent(cwd, forKey: .cwd)
      try c.encodeIfPresent(exitCode, forKey: .exitCode)
    case .diff(let path, let patch, let added, let removed):
      try c.encode("diff", forKey: .type)
      try c.encode(path, forKey: .path)
      try c.encode(patch, forKey: .patch)
      try c.encode(added, forKey: .added)
      try c.encode(removed, forKey: .removed)
    case .file(let path, let content):
      try c.encode("file", forKey: .type)
      try c.encode(path, forKey: .path)
      try c.encodeIfPresent(content, forKey: .content)
    case .todos(let todos):
      try c.encode("todos", forKey: .type)
      try c.encode(todos, forKey: .todos)
    case .search(let query, let path):
      try c.encode("search", forKey: .type)
      try c.encode(query, forKey: .query)
      try c.encodeIfPresent(path, forKey: .path)
    case .url(let url):
      try c.encode("url", forKey: .type)
      try c.encode(url, forKey: .url)
    case .unknown(let type):
      try c.encode(type, forKey: .type)
    }
  }
}

public struct ToolItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  public var name: String
  public var title: String
  public var status: ToolStatus
  public var input: JSONValue?
  public var detail: ToolDetail?
  public var output: String?
  public var outputTruncated: Bool?
  public var images: [ImageRef]?
  public var parentId: String?
}

public struct PermissionDecision: OpenEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let allow: Self = "allow"
  public static let allowAlways: Self = "allowAlways"
  public static let deny: Self = "deny"
}

public struct PermissionItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  public var toolName: String
  public var title: String
  public var input: JSONValue?
  public var detail: ToolDetail?
  /// pending | allowed | denied | cancelled
  public var status: String
  public var canAllowAlways: Bool?
  public var canDenyWithMessage: Bool?
  public var isPending: Bool { status == "pending" }
}

public struct QuestionOption: Codable, Hashable, Sendable {
  public var label: String
  public var description: String?
}

public struct Question: Codable, Hashable, Sendable {
  public var question: String
  public var header: String?
  public var multiSelect: Bool?
  public var options: [QuestionOption]
}

public struct QuestionItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  public var questions: [Question]
  /// pending | answered | cancelled
  public var status: String
  public var answers: [String: String]?
  public var isPending: Bool { status == "pending" }
}

public struct NoticeItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  /// info | warn | error
  public var level: String
  public var text: String
}

public struct TurnItem: Codable, Hashable, Sendable {
  public var id: String
  public var ts: Double
  /// completed | interrupted | error
  public var outcome: String
  public var durationMs: Double?
  public var costUsd: Double?
  public var inputTokens: Double?
  public var outputTokens: Double?
  public var error: String?
}

public enum ChatItem: Codable, Hashable, Sendable, Identifiable {
  case user(UserItem)
  case text(TextItem)
  case thinking(ThinkingItem)
  case tool(ToolItem)
  case permission(PermissionItem)
  case question(QuestionItem)
  case notice(NoticeItem)
  case turn(TurnItem)
  /// A kind this app does not know (or a known kind it could not read).
  case unknown(id: String, ts: Double, kind: String)

  private enum K: String, CodingKey { case kind, id, ts }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    let kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
    let id = try c.decode(String.self, forKey: .id)
    let ts = (try? c.decode(Double.self, forKey: .ts)) ?? 0
    do {
      switch kind {
      case "user": self = .user(try UserItem(from: decoder))
      case "text": self = .text(try TextItem(from: decoder))
      case "thinking": self = .thinking(try ThinkingItem(from: decoder))
      case "tool": self = .tool(try ToolItem(from: decoder))
      case "permission": self = .permission(try PermissionItem(from: decoder))
      case "question": self = .question(try QuestionItem(from: decoder))
      case "notice": self = .notice(try NoticeItem(from: decoder))
      case "turn": self = .turn(try TurnItem(from: decoder))
      default: self = .unknown(id: id, ts: ts, kind: kind)
      }
    } catch {
      self = .unknown(id: id, ts: ts, kind: kind)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: K.self)
    try c.encode(kind, forKey: .kind)
    switch self {
    case .user(let v): try v.encode(to: encoder)
    case .text(let v): try v.encode(to: encoder)
    case .thinking(let v): try v.encode(to: encoder)
    case .tool(let v): try v.encode(to: encoder)
    case .permission(let v): try v.encode(to: encoder)
    case .question(let v): try v.encode(to: encoder)
    case .notice(let v): try v.encode(to: encoder)
    case .turn(let v): try v.encode(to: encoder)
    case .unknown(let id, let ts, _):
      try c.encode(id, forKey: .id)
      try c.encode(ts, forKey: .ts)
    }
  }

  public var id: String {
    switch self {
    case .user(let v): v.id
    case .text(let v): v.id
    case .thinking(let v): v.id
    case .tool(let v): v.id
    case .permission(let v): v.id
    case .question(let v): v.id
    case .notice(let v): v.id
    case .turn(let v): v.id
    case .unknown(let id, _, _): id
    }
  }

  public var kind: String {
    switch self {
    case .user: "user"
    case .text: "text"
    case .thinking: "thinking"
    case .tool: "tool"
    case .permission: "permission"
    case .question: "question"
    case .notice: "notice"
    case .turn: "turn"
    case .unknown(_, _, let kind): kind
    }
  }

  /// Parent Task id for nested tool calls.
  public var parentId: String? {
    if case .tool(let t) = self { return t.parentId }
    return nil
  }

  /// A permission or question still waiting for the user.
  public var isPendingAsk: Bool {
    switch self {
    case .permission(let p): p.isPending
    case .question(let q): q.isPending
    default: false
    }
  }

  /// The same item with `text` appended (streaming text or thinking only).
  func appending(_ more: String) -> ChatItem? {
    switch self {
    case .text(var t):
      t.text += more
      return .text(t)
    case .thinking(var t):
      t.text += more
      return .thinking(t)
    default: return nil
    }
  }
}

// MARK: - Results

public struct FsEntry: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var dir: Bool
  public var hidden: Bool
  public var id: String { name }
}

public struct FsListResult: Codable, Hashable, Sendable {
  public var path: String
  public var parent: String?
  public var entries: [FsEntry]
}

public struct ResumableSession: Codable, Hashable, Sendable, Identifiable {
  public var agent: String
  public var resumeId: String
  public var cwd: String
  public var title: String
  public var updatedAt: Double
  public var messageCount: Double?
  public var agentName: String?
  public var sessionId: String?
  public var archived: Bool?
  public var snippet: String?
  public var id: String { sessionId ?? "\(agent):\(resumeId)" }
}

public struct HistoryQuery: Codable, Hashable, Sendable {
  public var text: String?
  public var cwd: String?
  public var limit: Int?
  public var before: Double?
  public init(text: String? = nil, cwd: String? = nil, limit: Int? = nil, before: Double? = nil) {
    self.text = text
    self.cwd = cwd
    self.limit = limit
    self.before = before
  }
}

public struct CreateSessionParams: Codable, Hashable, Sendable {
  public var kind: SessionKind
  public var agent: String?
  public var cwd: String?
  public var title: String?
  public var model: String?
  public var permissionMode: PermissionMode?
  public var resumeId: String?
  public var cols: Int?
  public var rows: Int?
  public var command: String?
  public init(
    kind: SessionKind, agent: String? = nil, cwd: String? = nil, title: String? = nil, model: String? = nil,
    permissionMode: PermissionMode? = nil, resumeId: String? = nil, cols: Int? = nil, rows: Int? = nil,
    command: String? = nil
  ) {
    self.kind = kind
    self.agent = agent
    self.cwd = cwd
    self.title = title
    self.model = model
    self.permissionMode = permissionMode
    self.resumeId = resumeId
    self.cols = cols
    self.rows = rows
    self.command = command
  }
}

public struct SendResult: Codable, Hashable, Sendable {
  public var itemId: String
}

public struct PairResponse: Codable, Hashable, Sendable {
  public struct Host: Codable, Hashable, Sendable {
    public var name: String
    public var platform: String
    public var user: String
  }
  public var deviceId: String
  public var token: String
  public var host: Host
}

public struct HandoffResponse: Codable, Hashable, Sendable {
  public var code: String
  public var expiresAt: Double
}
