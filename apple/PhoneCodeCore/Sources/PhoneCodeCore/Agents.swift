import Foundation

/// Harness helpers shared by the composer pickers and the chat header (ported
/// from packages/web/src/lib/agents.ts and lib/harness.ts).
public enum Agents {
  static let nativeNames = ["claude": "Claude Code", "codex": "Codex"]
  static let shortNames = ["claude": "Claude", "codex": "Codex"]

  /// Every agent the host offers; older daemons only send `agents`.
  public static func catalog(_ h: HostInfo?) -> [AgentInfo] {
    guard let h else { return [] }
    if let c = h.agentCatalog { return c }
    return h.agents.map {
      AgentInfo(
        id: $0.kind, name: nativeNames[$0.kind] ?? $0.kind, impl: .native, available: $0.available, version: $0.version,
        models: $0.models, modelOptions: nil, permissionModes: nil, source: nil, setupHint: nil, commands: nil)
    }
  }

  public static func find(_ h: HostInfo?, _ id: String?) -> AgentInfo? {
    guard let id else { return nil }
    return catalog(h).first { $0.id == id }
  }

  /// "Claude Code", "Codex", "Gemini CLI"…
  public static func label(_ s: SessionInfo, _ h: HostInfo?) -> String {
    if s.isTerminal { return "Terminal" }
    let id = s.agent ?? "claude"
    return s.agentName ?? find(h, id)?.name ?? nativeNames[id] ?? id
  }

  /// "Claude", "Codex", else the display name.
  public static func shortLabel(_ s: SessionInfo, _ h: HostInfo?) -> String {
    shortNames[s.agent ?? "claude"] ?? label(s, h)
  }

  public static func modelOptions(models: [String]?, options: [ModelOption]?) -> [ModelOption] {
    if let o = options, !o.isEmpty { return o }
    return (models ?? []).map { ModelOption(id: $0) }
  }

  public static func modelOptions(_ a: AgentInfo?) -> [ModelOption] {
    modelOptions(models: a?.models, options: a?.modelOptions)
  }

  /// A session's own models (reported once its agent started), else its agent's.
  public static func sessionModels(_ s: SessionInfo, _ h: HostInfo?) -> [ModelOption] {
    let own = modelOptions(models: s.models, options: s.modelOptions)
    return own.isEmpty ? modelOptions(find(h, s.agent ?? "claude")) : own
  }

  public static func currentModel(_ model: String?, _ options: [ModelOption]) -> ModelOption? {
    guard let model else { return options.first { $0.isDefault == true } }
    return options.first { $0.id == model } ?? options.first { $0.resolved == model && $0.isDefault != true }
      ?? options.first { $0.resolved == model }
  }

  /// Short label for the composer chip: the model in use, e.g. "Opus 4.7".
  public static func modelLabel(_ model: String?, _ options: [ModelOption]) -> String? {
    guard let cur = currentModel(model, options) else { return model }
    if cur.isDefault == true {
      let target = options.first { $0.isDefault != true && $0.resolved != nil && $0.resolved == cur.resolved }
      return target?.name ?? cur.description ?? cur.name ?? "Default"
    }
    return cur.name ?? cur.id
  }

  /// Thinking levels to offer: the session's own (ACP agents), else the current model's.
  public static func efforts(session s: SessionInfo, _ h: HostInfo?) -> [EffortOption] {
    if let own = s.efforts, !own.isEmpty { return own }
    return currentModel(s.model, sessionModels(s, h))?.efforts ?? []
  }

  /// Thinking levels for a new chat with this agent and model.
  public static func efforts(_ a: AgentInfo?, model: String?) -> [EffortOption] {
    currentModel(model, modelOptions(a))?.efforts ?? []
  }

  /// The level a chip shows: the chosen one, else the model's default.
  public static func effortLabel(_ effort: String?, _ options: [EffortOption], defaultEffort: String? = nil) -> String? {
    guard let id = effort ?? defaultEffort else { return nil }
    return options.first { $0.id == id }?.label ?? id
  }

  public static func modes(_ a: AgentInfo?) -> [PermissionMode] { a?.permissionModes ?? PermissionMode.classic }
  public static func modes(_ s: SessionInfo) -> [PermissionMode] { s.permissionModes ?? PermissionMode.classic }

  /// Agents to offer in the harness picker: ready ones first.
  public static func pickerList(_ h: HostInfo?) -> [AgentInfo] {
    let all = catalog(h)
    return all.filter(\.available) + all.filter { !$0.available }
  }
}

/// What the composer of a new chat will create.
public struct NewChatChoices: Hashable, Sendable {
  public var harness: String
  public var model: String?
  /// Thinking level; nil: the agent's own default.
  public var effort: String?
  public var mode: PermissionMode
  public var cwd: String
  public init(harness: String, model: String? = nil, effort: String? = nil, mode: PermissionMode = .default, cwd: String) {
    self.harness = harness
    self.model = model
    self.effort = effort
    self.mode = mode
    self.cwd = cwd
  }
}

/// Per-harness defaults: what a new chat with a harness starts with (the choices made last time).
public struct HarnessPrefs: Codable, Hashable, Sendable {
  public var model: String?
  public var effort: String?
  public var mode: String?
  public var cwd: String?
  public init(model: String? = nil, effort: String? = nil, mode: String? = nil, cwd: String? = nil) {
    self.model = model
    self.effort = effort
    self.mode = mode
    self.cwd = cwd
  }
}

public struct DraftPrefs: Codable, Hashable, Sendable {
  public var lastHarness: String?
  public var harness: [String: HarnessPrefs] = [:]
  public var recentDirs: [String] = []
  public init() {}

  /// The harness a new chat uses: the one picked, else the last used if ready, else the first ready agent.
  public func choices(host: HostInfo?, picked: String?) -> NewChatChoices {
    let list = Agents.catalog(host)
    func ready(_ id: String?) -> Bool { id.map { i in list.contains { $0.id == i && $0.available } } ?? false }
    let harness: String =
      if let picked, picked != "terminal" { picked } else if ready(lastHarness), let l = lastHarness { l } else {
        list.first(where: \.available)?.id ?? list.first?.id ?? "claude"
      }
    let info = list.first { $0.id == harness }
    let p = self.harness[harness] ?? HarnessPrefs()
    let models = Agents.modelOptions(info)
    let model = p.model.flatMap { m in models.contains { $0.id == m } ? m : nil }
    let modes = Agents.modes(info)
    let mode = modes.first { $0.rawValue == p.mode } ?? .default
    // A remembered level only if this model offers it (another model may not).
    let effort = p.effort.flatMap { e in Agents.efforts(info, model: model).contains { $0.id == e } ? e : nil }
    return NewChatChoices(harness: harness, model: model, effort: effort, mode: mode, cwd: p.cwd ?? host?.home ?? "~")
  }

  public mutating func remember(_ c: NewChatChoices) {
    lastHarness = c.harness
    harness[c.harness] = HarnessPrefs(model: c.model, effort: c.effort, mode: c.mode.rawValue, cwd: c.cwd)
    recentDirs = Array(([c.cwd] + recentDirs.filter { $0 != c.cwd }).prefix(6))
  }
}

/// Slash commands matching what was typed after the slash, grouped by source.
public enum SlashCommands {
  public static let order = ["project", "user", "plugin", "mcp", "builtin", "other"]
  public static let sourceLabel = [
    "project": "This project", "user": "Yours", "plugin": "Plugins", "mcp": "MCP servers", "builtin": "Built in",
    "other": "Commands",
  ]

  public struct Group: Identifiable, Hashable, Sendable {
    public var source: String
    public var items: [SlashCommand]
    public var id: String { source }
    public var label: String { sourceLabel[source] ?? source }
  }

  public static func group(_ list: [SlashCommand], typed: String) -> [Group] {
    let q = typed.lowercased()
    let hits = list.filter { q.isEmpty || $0.name.lowercased().contains(q) }.sorted { a, b in
      let pa = a.name.lowercased().hasPrefix(q) ? 0 : 1
      let pb = b.name.lowercased().hasPrefix(q) ? 0 : 1
      return pa != pb ? pa < pb : a.name < b.name
    }
    return order.compactMap { src in
      let items = hits.filter { ($0.source ?? "other") == src || (src == "other" && !order.contains($0.source ?? "other")) }
      return items.isEmpty ? nil : Group(source: src, items: items)
    }
  }
}
