import Foundation
import PhoneCodeCore
import Testing

@MainActor
final class TermRecorder: TerminalSink {
  var text = ""
  var snapshots = 0
  var exitCode: Int?? = nil
  func terminalSnapshot(data: String, cols: Int, rows: Int) {
    snapshots += 1
    text = data
  }
  func terminalData(_ data: String) { text += data }
  func terminalExit(code: Int?) { exitCode = .some(code) }
}

@Suite("Sessions, sync and devices against the real daemon", .serialized, .timeLimit(.minutes(2)))
@MainActor
struct SessionTests {
  @Test("archive, search across harnesses, resume, rename, delete")
  func archiveSearch() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let a = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.folder("archive-me")))
      client.subscribe(a.id)
      try await runTurn(client, a.id, "hello, remember the word pelican")
      let b = try await client.createSession(CreateSessionParams(kind: .agent, agent: "gemini", cwd: d.folder("other-chat")))
      client.subscribe(b.id)
      try await runTurn(client, b.id, "hello, the word is walrus")
      client.unsubscribe(a.id)

      try await client.archive(a.id)
      #expect(!client.sidebar.chats.contains { $0.id == a.id })
      try await waitUntil("daemon agrees") { client.session(a.id)?.isArchived == true }
      #expect(client.sidebar.chats.contains { $0.id == b.id })

      // Search finds it by message text, across harnesses, and knows it is ours and archived.
      let hits = try await client.history(HistoryQuery(text: "pelican"))
      let hit = try #require(hits.first { $0.sessionId == a.id })
      #expect(hit.archived == true)
      #expect(!hits.contains { $0.sessionId == b.id })
      let walrus = try await client.history(HistoryQuery(text: "walrus"))
      #expect(walrus.contains { $0.sessionId == b.id && $0.agent == "gemini" })
      let all = try await client.history(HistoryQuery())
      #expect(all.count >= 2)

      // Opening a search hit brings it back to the sidebar.
      let opened = try await client.open(hit)
      #expect(opened == a.id)
      try await waitUntil("unarchived") { client.session(a.id)?.isArchived == false }

      try await client.rename(a.id, title: "Pelicans")
      try await waitUntil("renamed") { client.session(a.id)?.title == "Pelicans" }
      try await client.delete(b.id)
      try await waitUntil("deleted") { client.session(b.id) == nil }
      client.stop()
    }
  }

  @Test("reconnect resumes with afterSeq: missed events replay, queued sends go out")
  func reconnect() async throws {
    try await withDaemon { d in
      let (client, _, rec) = try await pairAndConnect(d)
      let (other, _, _) = try await pairAndConnect(d, name: "second phone")
      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.folder("sync")))
      client.subscribe(s.id)
      let chat = client.chat(s.id)
      try await runTurn(client, s.id, "hello one")
      let snapshotsBefore = rec.frames("chat.snapshot").count
      let receivedBefore = rec.received.count

      // The link drops and stays down while another device keeps the chat going.
      rec.setRefuse(true)
      rec.dropAll()
      try await waitUntil("reconnecting") { client.status == .reconnecting }
      other.subscribe(s.id)
      try await runTurn(other, s.id, "hello two")
      // A message typed while offline waits in the outbox.
      let queued = Task { await client.sendChat(s.id, text: "hello three") }

      rec.setRefuse(false)
      client.retryNow()
      try await waitUntil("open again") { client.status == .open }
      await queued.value
      try await waitUntil("all three turns") { chat.turnCount == 3 }

      let subs = rec.sentFrames("sub").filter { $0["sessionId"]?.stringValue == s.id }
      let resub = try #require(subs.last)
      #expect(resub["afterSeq"]?.doubleValue != nil)
      // Replay, not a fresh snapshot.
      #expect(rec.frames("chat.snapshot").count == snapshotsBefore)
      #expect(rec.frames("chat.item", from: receivedBefore).isEmpty == false)
      let users = chat.allItems.compactMap { if case .user(let u) = $0 { u.text } else { nil } }
      #expect(users == ["hello one", "hello two", "hello three"])
      #expect(chat.pending.isEmpty)
      // Same transcript as a fresh subscriber's snapshot.
      #expect(Set(other.chat(s.id).allItems.map(\.id)).isSubset(of: Set(chat.allItems.map(\.id))))
      other.stop()
      client.stop()
    }
  }

  @Test("a daemon restart: reconnects and resyncs")
  func daemonRestart() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      let s = try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.folder("restart")))
      client.subscribe(s.id)
      try await runTurn(client, s.id, "hello before")
      try await d.restart()
      try await waitUntil("back", timeout: 30) { client.status == .open }
      try await runTurn(client, s.id, "hello after")
      let users = client.chat(s.id).allItems.compactMap { if case .user(let u) = $0 { u.text } else { nil } }
      #expect(users == ["hello before", "hello after"])
      client.stop()
    }
  }

  @Test("revoking on the computer and unpairing from the app both lock the device out")
  func revoke() async throws {
    try await withDaemon { d in
      let (client, creds, _) = try await pairAndConnect(d)
      var why: String?
      client.onUnauthorized = { why = $0 }
      let r = try await d.cli("revoke", creds.deviceId)
      #expect(r.code == 0)
      try await waitUntil("unauthorized") { if case .unauthorized = client.status { true } else { false } }
      #expect(why != nil)
      // The token no longer pairs or connects.
      let again = PhoneCodeClient(factory: RecordingFactory())
      again.start(creds)
      try await waitUntil("refused") { if case .unauthorized = again.status { true } else { false } }
      again.stop()

      let (second, creds2, _) = try await pairAndConnect(d, name: "unpair me", typed: true)
      try await PairingClient().unpair(creds2)
      try await waitUntil("unpaired") { if case .unauthorized = second.status { true } else { false } }
      do {
        _ = try await PairingClient().pair(origin: d.url, code: "NOPE-NOPE-NO", deviceName: "x")
        Issue.record("a bad code paired")
      } catch let e as PairingError {
        #expect(e.status == 401 || e.status == 429)
      }
      // Handoff: a paired device mints a code another app redeems.
      let (third, creds3, _) = try await pairAndConnect(d, name: "handoff source")
      let h = try await PairingClient().handoff(creds3)
      let redeemed = try await PairingClient().pair(origin: d.url, code: h.code, deviceName: "handoff target")
      #expect(redeemed.token != creds3.token)
      third.stop()
      client.stop()
      second.stop()
    }
  }

  @Test("terminal sessions: snapshot, input, output, resize, exit")
  func terminal() async throws {
    try await withDaemon { d in
      let (client, _, rec) = try await pairAndConnect(d)
      let s = try await client.openTerminal(cwd: d.project.path, cols: 80, rows: 24)
      #expect(s.isTerminal)
      let sink = TermRecorder()
      client.attachTerminal(s.id, sink)
      try await waitUntil("snapshot") { sink.snapshots == 1 }
      client.terminalInput(s.id, "echo swift-$((40+2))\r")
      try await waitUntil("echo output") { sink.text.contains("swift-42") }
      client.terminalResize(s.id, cols: 100, rows: 30)
      client.terminalInput(s.id, "stty size\r")
      try await waitUntil("resized") { sink.text.contains("30 100") }
      // A second view of the same terminal after detaching starts from a full snapshot.
      client.detachTerminal(s.id, sink)
      let again = TermRecorder()
      client.attachTerminal(s.id, again)
      try await waitUntil("fresh snapshot") { again.snapshots == 1 }
      #expect(again.text.contains("swift-42"))
      #expect(rec.sentFrames("sub").filter { $0["sessionId"]?.stringValue == s.id }.last?["afterSeq"] == nil)
      client.terminalInput(s.id, "exit\r")
      try await waitUntil("exit") { again.exitCode != nil }
      client.stop()
    }
  }

  @Test("Mac workspace: split, replace, move, resize, close, focus, persist, prune")
  func workspace() async throws {
    try await withDaemon { d in
      let (client, _, _) = try await pairAndConnect(d)
      var ids: [String] = []
      for n in 1...4 {
        ids.append(try await client.createSession(CreateSessionParams(kind: .agent, agent: "claude", cwd: d.folder("w\(n)"))).id)
      }
      let (a, b, c, e) = (ids[0], ids[1], ids[2], ids[3])
      var w = Workspace(sessionId: a)
      let ta = try #require(w.focusedTile?.id)
      let droppedB = w.drop(b, onto: ta, edge: .right)
      let tb = try #require(droppedB)
      #expect(w.shape == "h(\(a),\(b))")
      #expect(w.focused == tb)
      let droppedC = w.drop(c, onto: tb, edge: .bottom)
      let tc = try #require(droppedC)
      #expect(w.shape == "h(\(a),v(\(b),\(c)))")
      #expect(w.tiles.count == 3)
      // Centre replaces what a tile shows.
      w.drop(e, onto: tc, edge: .center)
      #expect(w.shape == "h(\(a),v(\(b),\(e)))")
      // Dropping a session that is already visible moves it.
      w.drop(a, onto: tb, edge: .top)
      #expect(w.shape == "v(v(\(a),\(b)),\(e))")
      // Rearrange by dragging a tile's title bar onto another edge.
      let te = try #require(w.tile(showing: e)?.id)
      w.move(te, onto: try #require(w.tile(showing: a)?.id), edge: .left)
      #expect(w.shape == "v(h(\(e),\(a)),\(b))")
      // Dividers clamp.
      let split = w.root.id
      w.setRatio(split, 0.01)
      #expect(w.root.ratio == Workspace.minRatio)
      w.setRatio(split, 0.7)
      #expect(w.root.ratio == 0.7)
      // Focus cycles in reading order.
      w.focus(te)
      w.focusNext()
      #expect(w.focusedTile?.sessionId == a)
      w.focusNext()
      #expect(w.focusedTile?.sessionId == b)
      w.focusNext()
      #expect(w.focusedTile?.sessionId == e)
      w.focusPrevious()
      #expect(w.focusedTile?.sessionId == b)
      // Persist and restore.
      let saved = try JSONEncoder().encode(w)
      var restored = try JSONDecoder().decode(Workspace.self, from: saved)
      #expect(restored == w)
      // A session deleted elsewhere leaves the layout.
      try await client.delete(a)
      try await waitUntil("deleted") { client.session(a) == nil }
      restored.prune(keeping: Set(client.sessions.map(\.id)))
      #expect(restored.shape == "v(\(e),\(b))")
      // Closing collapses; the last tile becomes a new chat.
      restored.close(try #require(restored.tile(showing: e)?.id))
      #expect(restored.shape == b)
      restored.close(restored.focused)
      #expect(restored.shape == "new")
      restored.open(c)
      #expect(restored.shape == c)
      client.stop()
    }
  }

  @Test("a newer daemon's frames still decode")
  func forwardCompatible() async throws {
    // Shapes a future daemon could send: an unknown message type, an unknown
    // item kind, unknown statuses and fields. None may fail the whole frame.
    let frames = [
      #"{"t":"hologram","x":1}"#,
      #"{"t":"chat.item","sessionId":"s","seq":3,"item":{"kind":"poll","id":"p1","ts":1,"options":[1,2]}}"#,
      #"{"t":"chat.item","sessionId":"s","seq":4,"item":{"kind":"tool","id":"t1","ts":1,"name":"Bash","title":"x","status":"paused","detail":{"type":"sandbox","id":3},"newField":true}}"#,
      #"{"t":"sessions","sessions":[{"id":"a","kind":"agent","title":"x","cwd":"/","createdAt":1,"updatedAt":2,"status":"sleeping","permissionMode":"yolo","color":"red"}]}"#,
    ]
    let decoded = frames.map { ServerMessage.decode(Data($0.utf8)) }
    #expect(decoded.allSatisfy { $0 != nil })
    if case .unknown(let t) = decoded[0] { #expect(t == "hologram") } else { Issue.record("not unknown") }
    if case .chatItem(_, _, let item) = decoded[1] { #expect(item.kind == "poll") } else { Issue.record("poll") }
    if case .chatItem(_, _, .tool(let tool)) = decoded[2] {
      #expect(tool.status.rawValue == "paused")
      #expect(tool.detail == .unknown(type: "sandbox"))
    } else { Issue.record("tool") }
    if case .sessions(let list) = decoded[3] { #expect(list.first?.status.rawValue == "sleeping") } else { Issue.record("sessions") }
    // Pairing links in every form the daemon or a user produces.
    #expect(PairingLink.parse("https://mac.tail1.ts.net/#/pair?c=K7QM-3XPA-9D") == PairingLink(code: "K7QM-3XPA-9D", origin: URL(string: "https://mac.tail1.ts.net")))
    #expect(PairingLink.parse("http://127.0.0.1:7777/?h=abc123")?.origin == URL(string: "http://127.0.0.1:7777"))
    #expect(PairingLink.parse("phonecode://pair?url=https%3A%2F%2Fmac.ts.net&c=ABCD1234")?.origin == URL(string: "https://mac.ts.net"))
    #expect(PairingLink.parse("k7qm3xpa9d") == PairingLink(code: "k7qm3xpa9d", origin: nil))
    #expect(PairingLink.parse("not a code!") == nil)
    #expect(PairingLink.originURL("mac.tail1.ts.net") == URL(string: "https://mac.tail1.ts.net"))
  }
}
