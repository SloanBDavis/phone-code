import Foundation

/// Decides when to tell the user about a session, from successive session
/// lists: it started waiting for them (permission or question), or an agent
/// finished working. The app turns these into local notifications.
public struct AttentionTracker: Sendable {
  public enum Event: Hashable, Sendable {
    case needsYou(SessionInfo)
    case finished(SessionInfo)
    case failed(SessionInfo)

    public var session: SessionInfo {
      switch self {
      case .needsYou(let s), .finished(let s), .failed(let s): s
      }
    }

    public var title: String {
      switch self {
      case .needsYou(let s): "\(s.title) needs you"
      case .finished(let s): "\(s.title) is done"
      case .failed(let s): "\(s.title) stopped"
      }
    }
  }

  private var last: [String: SessionStatus] = [:]
  private var primed = false

  public init() {}

  /// Events for the changes since the previous list. The first list only sets the baseline.
  public mutating func update(_ sessions: [SessionInfo]) -> [Event] {
    defer {
      last = Dictionary(sessions.map { ($0.id, $0.status) }, uniquingKeysWith: { a, _ in a })
      primed = true
    }
    guard primed else { return [] }
    var out: [Event] = []
    for s in sessions where s.kind == .agent && !s.isArchived {
      let before = last[s.id]
      if s.status == .waiting, before != .waiting {
        out.append(.needsYou(s))
      } else if before == .running, s.status == .idle {
        out.append(.finished(s))
      } else if before == .running, s.status == .error {
        out.append(.failed(s))
      }
    }
    return out
  }
}
