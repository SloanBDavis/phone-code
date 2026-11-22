import Foundation
import PhoneCodeCore
import Testing

/// Thinking levels end to end: the levels each agent offers reach the app,
/// the level chosen for a new chat and changed mid-chat reaches the agent
/// (each fake agent says which level it has when asked "thinking level"),
/// and the session reports the level in effect.
@Suite("Thinking levels against the real daemon", .serialized, .timeLimit(.minutes(2)))
@MainActor
struct EffortTests {
  private func level(_ client: PhoneCodeClient, _ id: String) async throws -> String? {
    try await runTurn(client, id, "what is your thinking level")
    return client.chat(id).lastResponse
  }

  @Test("Claude Code: levels per model, chosen at start, changed at once, reported back")
  func claude() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let host = try #require(client.host)
      let claude = Agents.find(host, "claude")
      // Levels come with the model; Haiku has none.
      let levels = Agents.efforts(claude, model: nil)
      #expect(levels.map(\.id) == ["low", "medium", "high", "xhigh", "max"])
      #expect(levels.first { $0.id == "xhigh" }?.label == "Extra high")
      #expect(Agents.efforts(claude, model: "haiku").isEmpty)

      // Chosen for a new chat.
      // The first message already runs at the chosen level.
      let draft = NewChatChoices(harness: "claude", effort: "max", mode: .default, cwd: d.folder("effort-claude"))
      let s = try await client.startChat(draft, text: "what is your thinking level")
      client.subscribe(s.id)
      try await waitUntil("first turn") { client.chat(s.id).turnCount == 1 }
      #expect(client.chat(s.id).lastResponse?.contains("max") == true)
      try await waitUntil("session reports max") { client.session(s.id)?.effort == "max" }
      #expect(Agents.efforts(session: try #require(client.session(s.id)), host).count == 5)

      // Changed in the chat: the running process takes it before the next message.
      client.setEffort(s.id, "low")
      try await waitUntil("session reports low") { client.session(s.id)?.effort == "low" }
      #expect(try await level(client, s.id)?.contains("low") == true)

      // A session started without a choice reports the user's own level.
      let plain = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.folder("effort-claude-2")))
      client.subscribe(plain.id)
      try await waitUntil("level from settings") { client.session(plain.id)?.effort == "high" }
      client.stop()
    }
  }

  @Test("Codex: levels from model/list, applied with the next turn")
  func codex() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let host = try #require(client.host)
      // Chosen at creation: the first turn/start carries it.
      let first = try await client.createSession(
        CreateSessionParams(kind: .agent, agent: "codex", cwd: d.folder("effort-codex-0"), effort: "high"))
      client.subscribe(first.id)
      #expect(try await level(client, first.id)?.contains("high") == true)

      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "codex", cwd: d.folder("effort-codex")))
      client.subscribe(s.id)
      try await runTurn(client, s.id, "hello")
      try await waitUntil("model/list reached the session") {
        client.session(s.id).map { !Agents.efforts(session: $0, host).isEmpty } ?? false
      }
      let session = try #require(client.session(s.id))
      let levels = Agents.efforts(session: session, host)
      #expect(levels.map(\.id) == ["low", "medium", "high", "xhigh"])
      #expect(levels.first?.description?.isEmpty == false)
      #expect(session.effort == "medium")
      // A model without reasoning levels: no picker.
      let mini = Agents.currentModel("gpt-fake-mini", Agents.sessionModels(session, host))
      #expect(mini != nil && mini?.efforts == nil)

      client.setEffort(s.id, "xhigh")
      try await waitUntil("session reports xhigh") { client.session(s.id)?.effort == "xhigh" }
      #expect(try await level(client, s.id)?.contains("xhigh") == true)
      client.stop()
    }
  }

  @Test("ACP agents: the thought_level option, with the agent's own names")
  func acp() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let host = try #require(client.host)
      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "gemini", cwd: d.folder("effort-acp")))
      client.subscribe(s.id)
      try await waitUntil("levels from config options") { client.session(s.id)?.efforts?.isEmpty == false }
      let session = try #require(client.session(s.id))
      #expect(Agents.efforts(session: session, host).map(\.label) == ["Low", "Medium", "Deep think"])
      #expect(session.effort == "medium")

      client.setEffort(s.id, "deep")
      try await waitUntil("session reports deep") { client.session(s.id)?.effort == "deep" }
      #expect(try await level(client, s.id)?.contains("deep") == true)

      // Chosen before the session exists: applied once the agent is up.
      let draft = NewChatChoices(harness: "gemini", effort: "low", mode: .default, cwd: d.folder("effort-acp-2"))
      let s2 = try await client.startChat(draft, text: "what is your thinking level")
      client.subscribe(s2.id)
      try await waitUntil("first turn") { client.chat(s2.id).turnCount == 1 }
      #expect(client.chat(s2.id).lastResponse?.contains("low") == true)
      client.stop()
    }
  }
}
