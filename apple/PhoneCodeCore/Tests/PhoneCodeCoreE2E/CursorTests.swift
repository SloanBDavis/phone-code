import Foundation
import PhoneCodeCore
import Testing

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Cursor's desktop app, followed through its hooks: this test plays Cursor,
/// running the hook script phone-code installs (as Cursor would, JSON on
/// stdin, JSON answer on stdout) against the real daemon.
@Suite("Cursor app bridge against the real daemon", .serialized, .timeLimit(.minutes(2)))
@MainActor
struct CursorTests {
  /// Runs `cursor-hook.sh <event>` with JSON on stdin; returns what it prints.
  nonisolated static func run(_ script: String, _ event: String, _ input: Data) async throws -> Data {
    try await withCheckedThrowingContinuation { cont in
      DispatchQueue.global().async {
        do {
          let p = Process()
          p.executableURL = URL(fileURLWithPath: "/bin/sh")
          p.arguments = [script, event]
          let stdin = Pipe()
          let stdout = Pipe()
          p.standardInput = stdin
          p.standardOutput = stdout
          try p.run()
          stdin.fileHandleForWriting.write(input)
          try stdin.fileHandleForWriting.close()
          let out = stdout.fileHandleForReading.readDataToEndOfFile()
          p.waitUntilExit()
          cont.resume(returning: out)
        } catch {
          cont.resume(throwing: error)
        }
      }
    }
  }

  static func json(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? ["_raw": String(decoding: data, as: UTF8.self)]
  }

  static func hook(_ d: Daemon, _ event: String, _ input: [String: Any]) async throws -> [String: Any] {
    let script = d.home.appendingPathComponent("cursor-hook.sh").path
    return json(try await run(script, event, try JSONSerialization.data(withJSONObject: input)))
  }

  @Test("connect, follow a Cursor chat, reply when its turn ends, disconnect")
  func bridge() async throws {
    let cursorDir = FileManager.default.temporaryDirectory.appendingPathComponent("pc-cursor-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: cursorDir, withIntermediateDirectories: true)
    // Someone else's hook is already there: connecting must keep it.
    let foreign = #"{"version":1,"hooks":{"sessionStart":[{"command":"other-tool session"}],"stop":[{"command":"other-tool stop"}]}}"#
    try foreign.write(to: cursorDir.appendingPathComponent("hooks.json"), atomically: true, encoding: .utf8)
    let env = ["PHONECODE_CURSOR_DIR": cursorDir.path, "PHONECODE_CURSOR_HOLD_MS": "20000"]
    try await withDaemon(env: env) { d in
      let (client, _, _) = try await pairAndConnect(d)
      #expect(client.host?.cursor?.installed == true)
      #expect(client.host?.cursor?.connected == false)

      // Connect: the script is installed and listed, other hooks kept.
      let status = try await client.setCursorConnected(true)
      #expect(status.connected)
      let hooks = try JSONSerialization.jsonObject(with: Data(contentsOf: cursorDir.appendingPathComponent("hooks.json"))) as? [String: Any]
      let lists = hooks?["hooks"] as? [String: [[String: Any]]] ?? [:]
      #expect((lists["stop"] ?? []).contains { ($0["command"] as? String) == "other-tool stop" })
      #expect((lists["stop"] ?? []).contains { ($0["command"] as? String)?.contains("cursor-hook.sh") == true })
      #expect((lists["sessionStart"] ?? []).count == 1)
      #expect(lists["afterAgentResponse"]?.count == 1)
      // Not a choice for new chats.
      #expect(Agents.find(client.host, "cursor-app") == nil)

      let conv = "conv-\(UUID().uuidString)"
      let base: [String: Any] = ["conversation_id": conv, "workspace_roots": [d.project.path], "hook_event_name": "x"]
      func ev(_ extra: [String: Any]) -> [String: Any] { base.merging(extra) { _, new in new } }

      // A prompt at the desktop: a Cursor chat appears, with the prompt as its title.
      #expect(try await Self.hook(d, "beforeSubmitPrompt", ev(["generation_id": "g1", "prompt": "fix the login bug"])).isEmpty)
      try await waitUntil("cursor session") { client.sessions.contains { $0.agent == "cursor-app" } }
      let s = try #require(client.sessions.first { $0.agent == "cursor-app" })
      #expect(s.agentName == "Cursor")
      #expect(s.title == "fix the login bug")
      #expect(s.status == .running)
      client.subscribe(s.id)
      let chat = client.chat(s.id)
      try await waitUntil("prompt") { chat.allItems.contains { if case .user(let u) = $0 { u.text == "fix the login bug" } else { false } } }

      // Following along: thinking, a command, an edit, the answer.
      _ = try await Self.hook(d, "afterAgentThought", ev(["generation_id": "g1", "text": "Looking at auth.ts"]))
      _ = try await Self.hook(
        d, "postToolUse",
        ev(["generation_id": "g1", "tool_name": "Shell", "tool_use_id": "t1", "tool_input": ["command": "npm test"], "tool_output": "1 failing"]))
      _ = try await Self.hook(
        d, "afterFileEdit",
        ev(["generation_id": "g1", "file_path": "\(d.project.path)/auth.ts", "edits": [["old_string": "a\n", "new_string": "b\n"]]]))
      _ = try await Self.hook(d, "afterAgentResponse", ev(["generation_id": "g1", "text": "Fixed: the token was compared too early."]))
      try await waitUntil("answer") { chat.lastResponse == "Fixed: the token was compared too early." }
      #expect(chat.tools("Bash").first?.title == "npm test")
      #expect(chat.allItems.contains { if case .thinking = $0 { true } else { false } })
      #expect(chat.allItems.contains { if case .tool(let t) = $0, case .diff = t.detail { true } else { false } })

      // The turn ends while the phone follows: the hook waits for the reply...
      let script = d.home.appendingPathComponent("cursor-hook.sh").path
      let stopInput = try JSONSerialization.data(withJSONObject: ev(["generation_id": "g1", "status": "completed", "loop_count": 0]))
      async let stopped = Self.run(script, "stop", stopInput)
      try await waitUntil("waiting for a reply") { client.session(s.id)?.status == .waiting }
      // ...and the reply goes back to Cursor as the next message.
      await client.sendChat(s.id, text: "now add a test for it")
      let answer = Self.json(try await stopped)
      #expect(answer["followup_message"] as? String == "now add a test for it")
      #expect(chat.turnCount == 1)

      // Cursor submits it: no second copy of the message.
      _ = try await Self.hook(d, "beforeSubmitPrompt", ev(["generation_id": "g2", "prompt": "now add a test for it"]))
      let userCount = chat.allItems.filter { if case .user = $0 { true } else { false } }.count
      #expect(userCount == 2)

      // A reply sent while Cursor works goes out as soon as the turn ends.
      await client.sendChat(s.id, text: "and update the changelog")
      let queued = try await Self.hook(d, "stop", ev(["generation_id": "g2", "status": "completed", "loop_count": 1]))
      #expect(queued["followup_message"] as? String == "and update the changelog")

      // Nobody follows the chat: the turn's end is not held up.
      client.unsubscribe(s.id)
      try await Task.sleep(for: .milliseconds(300))
      _ = try await Self.hook(d, "beforeSubmitPrompt", ev(["generation_id": "g3", "prompt": "and update the changelog"]))
      let started = Date()
      let free = try await Self.hook(d, "stop", ev(["generation_id": "g3", "status": "completed", "loop_count": 2]))
      #expect(free.isEmpty)
      #expect(Date().timeIntervalSince(started) < 5)

      // Disconnect: only phone-code's hooks go.
      let off = try await client.setCursorConnected(false)
      #expect(!off.connected)
      let after = try JSONSerialization.jsonObject(with: Data(contentsOf: cursorDir.appendingPathComponent("hooks.json"))) as? [String: Any]
      let afterLists = after?["hooks"] as? [String: [[String: Any]]] ?? [:]
      #expect(afterLists["stop"]?.count == 1)
      #expect(afterLists["sessionStart"]?.count == 1)
      #expect(afterLists["afterAgentResponse"] == nil)
      client.stop()
    }
    // Without phone-code running, the script answers {} at once (Cursor carries on).
  }
}
