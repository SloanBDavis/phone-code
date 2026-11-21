import Foundation
import PhoneCodeCore
import Testing

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Runs `body` against a fresh daemon and always disposes of it.
@MainActor
func withDaemon(env: [String: String] = [:], _ body: (Daemon) async throws -> Void) async throws {
  let d = try await Daemon.start(env: env)
  do {
    try await body(d)
  } catch {
    print("---- daemon output ----\n\(d.output)")
    await d.dispose()
    throw error
  }
  await d.dispose()
}

@MainActor
func runTurn(_ client: PhoneCodeClient, _ sessionId: String, _ text: String, attachments: [PhoneCodeCore.Attachment] = []) async throws {
  let c = client.chat(sessionId)
  let before = c.turnCount
  await client.sendChat(sessionId, text: text, attachments: attachments)
  try await waitUntil("turn end after \(text)") { c.turnCount > before }
}

@Suite("Chats against the real daemon", .serialized, .timeLimit(.minutes(2)))
@MainActor
struct ChatTests {
  @Test("pair, connect, first send creates the session, the answer streams")
  func firstSendStreams() async throws {
    try await withDaemon { d in
      let (client, creds, rec) = try await pairAndConnect(d)
      #expect(creds.hostName.isEmpty == false)
      let host = try #require(client.host)
      #expect(host.user == "tester")
      let claude = try #require(Agents.find(host, "claude"))
      #expect(claude.available)
      #expect(Agents.catalog(host).contains { $0.id == "codex" })

      // The composer's choices: claude in the project folder, remembered for next time.
      var prefs = DraftPrefs()
      var draft = prefs.choices(host: host, picked: "claude")
      draft.cwd = d.project.path
      #expect(draft.harness == "claude")
      #expect(draft.mode == .default)
      let s = try await client.startChat(draft, text: "hello there")
      prefs.remember(draft)
      #expect(prefs.choices(host: host, picked: nil).cwd == d.project.path)
      #expect(client.starting == nil)
      #expect(client.sessions.first?.id == s.id)
      #expect(s.cwd == d.project.path)

      client.subscribe(s.id)
      let chat = client.chat(s.id)
      try await waitUntil("first turn") { chat.turnCount == 1 }
      #expect(chat.pending.isEmpty)
      guard case .user(let u) = chat.item(chat.ids[0]) else { Issue.record("first item is not the user message"); return }
      #expect(u.text == "hello there")
      let text = try #require(chat.texts.last)
      #expect(!text.isEmpty)
      if case .text(let t) = chat.allItems.last(where: { $0.kind == "text" }) { #expect(t.streaming == false) }
      // It really streamed: deltas arrived and were applied to one item.
      #expect(rec.frames("chat.delta").count > 2)
      #expect(chat.lastTurn?.outcome == "completed")
      // The streamed markdown: a paragraph with bold, a bullet list with inline code.
      let blocks = Markdown.blocks(text)
      #expect(blocks.contains { if case .list(false, let items) = $0 { items.count == 3 } else { false } })
      #expect(blocks.first == .paragraph("Hello! I'm a **fake Claude** used by the phone-code test suite."))
      let code = Syntax.tokens("let x = \"hi\" // note", language: "swift")
      #expect(code.map(\.kind).contains(.keyword) && code.map(\.kind).contains(.string) && code.last?.kind == .comment)
      try await waitUntil("idle") { client.session(s.id)?.status == .idle }
      client.stop()
    }
  }

  @Test("permission allow and deny, the attention tracker sees 'needs you' and 'done'")
  func permissions() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      var tracker = AttentionTracker()
      var events: [AttentionTracker.Event] = []
      _ = tracker.update(client.sessions)
      client.onSessions = { events += tracker.update($0) }

      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.folder("perm")))
      client.subscribe(s.id)
      let chat = client.chat(s.id)
      try await waitUntil("snapshot") { chat.loaded }

      await client.sendChat(s.id, text: "please run tests")
      try await waitUntil("permission card") { !chat.asks.isEmpty }
      guard case .permission(let p) = chat.item(chat.asks[0]) else { Issue.record("not a permission"); return }
      #expect(p.isPending)
      #expect(p.toolName == "Bash")
      try await waitUntil("needs you in the sidebar") { client.sidebar.needsYou.contains { $0.id == s.id } }
      #expect(events.contains(.needsYou(client.session(s.id)!)) || events.contains { if case .needsYou(let x) = $0 { x.id == s.id } else { false } })

      client.answerPermission(s.id, itemId: p.id, .allow)
      try await waitUntil("turn 1") { chat.turnCount == 1 }
      #expect(chat.asks.isEmpty)
      if case .permission(let done) = chat.item(p.id) { #expect(done.status == "allowed") }
      let bash = try #require(chat.tools("Bash").first)
      #expect(bash.status == .done)
      if case .command(let cmd, _, _) = bash.detail { #expect(cmd.contains("npm test")) } else { Issue.record("no command detail") }
      #expect((bash.output ?? "").isEmpty == false)
      // The answer's markdown table renders as a table block.
      let blocks = Markdown.blocks(chat.texts.last ?? "")
      let table = blocks.compactMap { if case .table(let h, _, let rows) = $0 { (h, rows) } else { nil } }.first
      #expect(table?.0 == ["test", "time"])
      #expect(table?.1.count == 3)
      try await waitUntil("finished event") { events.contains { if case .finished(let x) = $0 { x.id == s.id } else { false } } }

      await client.sendChat(s.id, text: "run tests again")
      try await waitUntil("second permission") { !chat.asks.isEmpty }
      let second = chat.asks[0]
      client.answerPermission(s.id, itemId: second, .deny, message: "not now")
      try await waitUntil("turn 2") { chat.turnCount == 2 }
      if case .permission(let denied) = chat.item(second) { #expect(denied.status == "denied") }
      #expect(chat.tools("Bash").last?.status == .denied || chat.tools("Bash").last?.status == .error)
      client.stop()
    }
  }

  @Test("a question card is answered with an option")
  func question() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.project.path))
      client.subscribe(s.id)
      let chat = client.chat(s.id)
      await client.sendChat(s.id, text: "ask me something")
      try await waitUntil("question") { !chat.asks.isEmpty }
      guard case .question(let q) = chat.item(chat.asks[0]) else { Issue.record("not a question"); return }
      let first = try #require(q.questions.first)
      let label = try #require(first.options.first?.label)
      client.answerQuestion(s.id, itemId: q.id, answers: [first.question: label])
      try await waitUntil("answered turn") { chat.turnCount == 1 }
      if case .question(let a) = chat.item(q.id) { #expect(a.status == "answered") }
      #expect(chat.texts.last?.contains(label) == true)
      client.stop()
    }
  }

  @Test("every harness: Codex and an ACP agent answer too; tools render as cards")
  func harnesses() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let host = try #require(client.host)
      #expect(Agents.find(host, "gemini")?.impl == .acp)
      for agent in ["codex", "gemini"] {
        let draft = NewChatChoices(harness: agent, mode: .default, cwd: d.folder("h-\(agent)"))
        let s = try await client.startChat(draft, text: "hello from swift")
        client.subscribe(s.id)
        let chat = client.chat(s.id)
        try await waitUntil("\(agent) turn") { chat.turnCount == 1 }
        #expect(chat.texts.last?.isEmpty == false)
        #expect(client.session(s.id)?.agent == agent)
      }
      // Todos and sub-agents (claude): nested tool calls land under their Task.
      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.project.path, permissionMode: .bypassPermissions))
      client.subscribe(s.id)
      let chat = client.chat(s.id)
      try await runTurn(client, s.id, "make a todo list")
      let todo = chat.allItems.compactMap { if case .tool(let t) = $0, case .todos(let list) = t.detail { list } else { nil } }.last
      #expect(todo?.count == 3)
      #expect(todo?.allSatisfy { $0.status == "completed" } == true)
      try await runTurn(client, s.id, "use an agent")
      let task = try #require(chat.tools("Task").first)
      #expect((chat.children[task.id] ?? []).isEmpty == false)
      #expect(!chat.ids.contains(chat.children[task.id]?.first ?? "-"))
      // A diff: edit file creates notes.md, a second edit changes it.
      try await runTurn(client, s.id, "edit file")
      try await runTurn(client, s.id, "edit file")
      let diff = chat.allItems.compactMap { if case .tool(let t) = $0, case .diff(let path, let patch, let added, _) = t.detail { (path, patch, added) } else { nil } }.last
      #expect(diff?.0.hasSuffix("notes.md") == true)
      let lines = UnifiedDiff.lines(diff?.1 ?? "")
      #expect(lines.contains { $0.kind == .added && $0.text == "hello phone-code" && $0.newLine != nil })
      #expect(lines.contains { $0.kind == .removed && $0.text == "hello world" })
      // Slash commands for the composer palette.
      let cmds = try await client.commands(s.id)
      #expect(!cmds.isEmpty)
      let groups = SlashCommands.group(cmds, typed: "")
      #expect(groups.reduce(0) { $0 + $1.items.count } == cmds.count)
      // Interrupt a long answer.
      await client.sendChat(s.id, text: "tell me something long")
      try await waitUntil("streaming") { chat.allItems.contains { if case .text(let t) = $0 { t.streaming } else { false } } }
      client.interrupt(s.id)
      try await waitUntil("interrupted") { chat.lastTurn?.outcome == "interrupted" }
      // Mode and model changes reach the session.
      client.setMode(s.id, .plan)
      try await waitUntil("mode") { client.session(s.id)?.permissionMode == .plan }
      client.stop()
    }
  }

  @Test("images: send a photo, fetch it with the token, thumbnails, cache")
  func images() async throws {
    try await withDaemon { d in
      let (client, creds, _) = try await pairAndConnect(d)
      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.project.path))
      client.subscribe(s.id)
      let chat = client.chat(s.id)
      try await runTurn(client, s.id, "what is this", attachments: [PhoneCodeCore.Attachment(mediaType: "image/png", name: "dot.png", data: tinyPNG)])
      guard case .user(let u) = chat.allItems.first(where: { $0.kind == "user" }) else { Issue.record("no user item"); return }
      let ref = try #require(u.images?.first)
      #expect(ref.mediaType == "image/png")
      #expect(chat.texts.last?.contains("image") == true)

      let loader = ImageLoader(credentials: creds)
      let bytes = try await loader.data(sessionId: s.id, imageId: ref.id)
      #expect(Array(bytes.prefix(4)) == [0x89, 0x50, 0x4E, 0x47])
      _ = try await loader.data(sessionId: s.id, imageId: ref.id)
      #expect(await loader.cachedCount() == 1)
      let thumb = try await loader.data(sessionId: s.id, imageId: ref.id, width: 64)
      #expect(!thumb.isEmpty)
      // Without the token: refused. (A fresh ephemeral session: URLSession.shared
      // would answer from its cache, since the daemon marks images immutable.)
      let (_, res) = try await URLSession(configuration: .ephemeral).data(from: loader.url(sessionId: s.id, imageId: ref.id))
      #expect((res as? HTTPURLResponse)?.statusCode == 401)

      // An agent tool result with an image (a Read of a screenshot).
      try await runTurn(client, s.id, "take a screenshot")
      let read = chat.allItems.compactMap { if case .tool(let t) = $0, let i = t.images?.first { i } else { nil } }.first
      let shot = try #require(read)
      let shotBytes = try await loader.data(sessionId: s.id, imageId: shot.id)
      #expect(Array(shotBytes.prefix(4)) == [0x89, 0x50, 0x4E, 0x47])
      client.stop()
    }
  }
}
