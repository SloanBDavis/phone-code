import PhoneCodeCore
import SwiftUI

/// One transcript row. It reads only its own `ItemBox`, so streaming text
/// re-renders this row and nothing else.
struct ItemRow: View {
  let box: ItemBox
  let chat: ChatState
  let session: SessionInfo

  var body: some View {
    content.padding(.vertical, gap)
  }

  /// Space above and below a row: a run of tool calls reads as one list,
  /// messages and cards get room.
  private var gap: CGFloat {
    switch box.item {
    case .tool, .thinking: 1
    case .permission(let p): p.isPending ? 8 : (p.status == "allowed" ? 0 : 2)
    case .notice: 4
    default: 8
    }
  }

  @ViewBuilder
  private var content: some View {
    switch box.item {
    case .user(let u): UserBubble(item: u, sessionId: session.id)
    case .text(let t): AssistantText(item: t, sessionId: session.id)
    case .thinking(let t): ThinkingRow(item: t)
    case .tool(let t):
      if t.name == "Task" {
        SubagentCard(tool: t, chat: chat, session: session)
      } else if case .document(let d) = t.detail, chat.latestDocument(d.path)?.id == t.id {
        DocumentCard(tool: t, doc: d, chat: chat, session: session)
      } else {
        ToolCard(tool: t, chat: chat, session: session)
      }
    case .permission(let p): PermissionCard(item: p, session: session)
    case .question(let q): QuestionCard(item: q, session: session)
    case .notice(let n): NoticeRow(item: n)
    case .turn(let t): TurnFooter(item: t)
    case .unknown(_, _, let kind):
      Label("Update phone-code on this device to see “\(kind)”", systemImage: "questionmark.circle")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }
}

struct UserBubble: View {
  let item: UserItem
  let sessionId: String

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if let images = item.images, !images.isEmpty {
        ImageStrip(sessionId: sessionId, images: images)
      }
      if !item.text.isEmpty {
        Text(item.text)
          .textSelection(.enabled)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(Theme.bubble, in: .rect(cornerRadius: 20))
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 48)
    .axContainer("chat-item-user")
  }
}

struct PendingBubble: View {
  let pending: PendingSend
  var onRetry: (() -> Void)?

  var body: some View {
    VStack(alignment: .trailing, spacing: 4) {
      Text(pending.text)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Theme.bubble.opacity(0.6), in: .rect(cornerRadius: 20))
      if pending.status == .failed {
        HStack {
          Label(pending.error ?? "Not sent", systemImage: "exclamationmark.circle")
            .font(.caption)
            .foregroundStyle(.red)
          if let onRetry { Button("Retry", action: onRetry).font(.caption.bold()) }
        }
      } else {
        Text(pending.attachments.isEmpty ? "Sending…" : "Sending \(pending.attachments.count) photo(s)…")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 48)
    .axContainer("pending-send")
  }
}

struct AssistantText: View {
  let item: TextItem
  let sessionId: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      MarkdownView(text: item.text)
      if item.streaming && item.text.isEmpty {
        ProgressView().controlSize(.small)
      }
      if let images = item.images, !images.isEmpty {
        ImageStrip(sessionId: sessionId, images: images)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .axContainer("chat-item-text")
  }
}

struct ThinkingRow: View {
  let item: ThinkingItem
  @State private var open = false

  var body: some View {
    DisclosureGroup(isExpanded: $open) {
      Text(item.text)
        .font(.callout)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    } label: {
      Text(item.streaming ? "Thinking…" : "Thought")
        .font(.callout)
        .foregroundStyle(.secondary)
    }
    .axContainer("chat-item-thinking")
  }
}

struct NoticeRow: View {
  let item: NoticeItem

  var body: some View {
    Label(item.text, systemImage: item.level == "error" ? "xmark.octagon" : item.level == "warn" ? "exclamationmark.triangle" : "info.circle")
      .font(.footnote)
      .foregroundStyle(item.level == "error" ? .red : item.level == "warn" ? .orange : .secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityIdentifier("chat-item-notice")
  }
}

struct TurnFooter: View {
  let item: TurnItem

  /// "Done · 1m 24s · $0.11", like the web app.
  private var summary: String {
    var parts: [String] = []
    switch item.outcome {
    case "interrupted": parts.append("Stopped")
    case "error": parts.append(item.error ?? "Error")
    default: parts.append("Done")
    }
    if let ms = item.durationMs {
      parts.append(Duration.milliseconds(Int64(ms)).formatted(.units(allowed: [.minutes, .seconds], width: .narrow)))
    }
    if let c = item.costUsd, c > 0 { parts.append(c.formatted(.currency(code: "USD").precision(.fractionLength(2...4)))) }
    let tokens = (item.inputTokens ?? 0) + (item.outputTokens ?? 0)
    if tokens > 0 {
      parts.append(tokens >= 1000 ? String(format: "%.1fk tokens", tokens / 1000) : "\(Int(tokens)) tokens")
    }
    // How full the model's context is after this turn.
    if let used = item.contextTokens, let window = item.contextWindow, used > 0, window > 0 {
      parts.append("context \(min(100, Int((used / window * 100).rounded())))%")
    }
    return parts.joined(separator: " · ")
  }

  var body: some View {
    HStack(spacing: 10) {
      VStack { Divider() }
      Text(summary)
        .font(.caption)
        .foregroundStyle(item.outcome == "error" ? AnyShapeStyle(Color.red) : AnyShapeStyle(.tertiary))
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
      VStack { Divider() }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("chat-item-turn")
  }
}

// MARK: - Tools

struct ToolCard: View {
  let tool: ToolItem
  let chat: ChatState
  let session: SessionInfo
  @State private var open: Bool?

  private var expanded: Bool {
    open ?? {
      if case .todos = tool.detail { return true }
      if case .diff = tool.detail { return true }
      return false
    }()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.snappy(duration: 0.2)) { open = !expanded }
      } label: {
        HStack(spacing: 7) {
          Image(systemName: Self.symbol(tool.name))
            .font(.caption)
            .frame(width: 16)
            .foregroundStyle(.tertiary)
          Text(Self.verb(tool))
            .foregroundStyle(.secondary)
          if !tool.title.isEmpty, tool.title != tool.name {
            Text(tool.title)
              .font(tool.name == "Bash" ? .callout.monospaced() : .callout)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          if case .diff(_, _, let added, let removed) = tool.detail {
            Text("+\(added)").foregroundStyle(Theme.diffAddText).font(.caption.monospaced())
            Text("−\(removed)").foregroundStyle(Theme.diffDelText).font(.caption.monospaced())
          }
          ToolStatusIcon(status: tool.status)
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.quaternary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
          Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.vertical, 4)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if expanded {
        ToolDetailView(tool: tool, sessionId: session.id)
          .padding(.leading, 23)
          .padding(.top, 4)
          .padding(.bottom, 8)
      } else if let images = tool.images, !images.isEmpty {
        ImageStrip(sessionId: session.id, images: images)
          .padding(.leading, 23)
          .padding(.bottom, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .axContainer("chat-item-tool")
  }

  /// "Ran", "Read", "Edited": what the line says before the command, file or query.
  static func verb(_ tool: ToolItem) -> String {
    let running = tool.status == .running
    switch tool.name {
    case "Bash": return running ? "Running" : "Ran"
    case "Read": return running ? "Reading" : "Read"
    case "Write", "Document": return running ? "Writing" : "Wrote"
    case "Edit": return running ? "Editing" : "Edited"
    case "Glob", "Grep": return running ? "Searching" : "Searched"
    case "WebFetch": return running ? "Fetching" : "Fetched"
    case "WebSearch": return running ? "Searching the web" : "Searched the web"
    case "Todo", "TodoWrite": return "Plan"
    case "Task": return "Agent"
    default: return tool.name
    }
  }

  static func symbol(_ name: String) -> String {
    switch name {
    case "Bash": "terminal"
    case "Read", "Document": "doc.text"
    case "Write": "square.and.pencil"
    case "Edit": "pencil.line"
    case "Glob", "Grep": "magnifyingglass"
    case "WebFetch": "globe"
    case "WebSearch": "magnifyingglass.circle"
    case "Todo", "TodoWrite": "checklist"
    case "Task": "person.2"
    default: "wrench.and.screwdriver"
    }
  }
}

// MARK: - Sub-agents

/// What a sub-agent is doing now ("Running ls") and how many steps it took, from its nested items.
@MainActor
func subagentProgress(_ chat: ChatState, _ id: String) -> (doing: String, steps: Int) {
  var steps = 0
  var doing = ""
  for k in chat.children[id] ?? [] {
    guard case .tool(let t)? = chat.item(k) else { continue }
    steps += 1
    if t.status == .running { doing = "\(ToolCard.verb(t)) \(t.title)" }
  }
  return (doing, steps)
}

func stepsText(_ n: Int) -> String { "\(n) \(n == 1 ? "step" : "steps")" }

/// One line about a sub-agent: what it does now, or how it ended.
@MainActor
func subagentStatus(_ chat: ChatState, _ tool: ToolItem) -> String {
  let p = subagentProgress(chat, tool.id)
  switch tool.status {
  case .running: return [p.doing.isEmpty ? "Starting" : p.doing, p.steps > 0 ? stepsText(p.steps) : ""].filter { !$0.isEmpty }.joined(separator: " · ")
  case .error: return "Failed · \(stepsText(p.steps))"
  case .denied: return "Stopped"
  default: return "Done · \(stepsText(p.steps))"
  }
}

/// A sub-agent in the chat: one compact card with its name, what it is doing now (or
/// how it ended) and its report. A tap opens it, to watch it work or read all it did.
struct SubagentCard: View {
  let tool: ToolItem
  let chat: ChatState
  let session: SessionInfo
  @State private var watching = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        watching = true
      } label: {
        HStack(spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text("Agent").font(.callout.weight(.medium))
              Text(tool.title).font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(subagentStatus(chat, tool))
              .font(.footnote)
              .foregroundStyle(.tertiary)
              .lineLimit(1)
              .accessibilityIdentifier("task-status")
          }
          Spacer(minLength: 0)
          ToolStatusIcon(status: tool.status)
          Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.quaternary)
        }
        .padding(10)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("task-open")
      if tool.status != .running, let report = tool.output?.trimmingCharacters(in: .whitespacesAndNewlines), !report.isEmpty {
        Divider().padding(.horizontal, 12)
        Text(Markdown.plain(report))
          .font(.callout)
          .foregroundStyle(.secondary)
          .lineLimit(4)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
      }
    }
    .background(Theme.card, in: .rect(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.hairline))
    .padding(.vertical, 4)
    .sheet(isPresented: $watching) { SubagentSheet(toolId: tool.id, chat: chat, session: session) }
    .axContainer("chat-item-task")
  }
}

/// A sub-agent, full screen: its brief, every step and what it said, in order, and its report.
struct SubagentSheet: View {
  let toolId: String
  let chat: ChatState
  let session: SessionInfo
  @Environment(\.dismiss) private var dismiss

  private var tool: ToolItem? {
    if case .tool(let t)? = chat.box(toolId)?.item { return t }
    return nil
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        if let t = tool {
          let report = t.status == .running ? "" : (t.output ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
              if t.status == .running { ProgressView().controlSize(.mini) }
              Text(subagentStatus(chat, t)).foregroundStyle(.secondary)
            }
            .font(.subheadline)
            if let prompt = t.input?["prompt"]?.stringValue, !prompt.isEmpty {
              Text(prompt)
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.fill.tertiary, in: .rect(cornerRadius: 12))
            }
            ForEach(chat.children[t.id] ?? [], id: \.self) { id in
              if let b = chat.box(id), !Self.isReport(b.item, report) {
                ItemRow(box: b, chat: chat, session: session)
              }
            }
            if !report.isEmpty {
              Divider()
              MarkdownView(text: report)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding()
        }
      }
      .navigationTitle(tool?.title ?? "Agent")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }.accessibilityIdentifier("watch-close")
        }
      }
    }
    .axContainer("watch-sheet")
  }

  /// The sub-agent's last message is its report: shown once, as the report.
  private static func isReport(_ item: ChatItem, _ report: String) -> Bool {
    guard !report.isEmpty, case .text(let t) = item else { return false }
    return t.text.trimmingCharacters(in: .whitespacesAndNewlines) == report
  }
}

/// The sub-agents at work in this chat, above the composer: each names itself and what
/// it does now, and opens to watch.
struct RunningStrip: View {
  let chat: ChatState
  let session: SessionInfo
  @State private var watching: WatchTarget?

  struct WatchTarget: Identifiable {
    let id: String
  }

  private var running: [ToolItem] {
    chat.ids.compactMap { id in
      if case .tool(let t)? = chat.item(id), t.name == "Task", t.status == .running { return t }
      return nil
    }
  }

  var body: some View {
    let list = running
    if !list.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini)
          Text(list.count == 1 ? "Running" : "\(list.count) running")
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
          ForEach(list, id: \.id) { t in
            Button {
              watching = WatchTarget(id: t.id)
            } label: {
              HStack(spacing: 5) {
                Text(t.title).font(.footnote.weight(.medium)).lineLimit(1)
                let p = subagentProgress(chat, t.id)
                let more = [p.doing, p.steps > 0 ? stepsText(p.steps) : ""].filter { !$0.isEmpty }.joined(separator: " · ")
                if !more.isEmpty {
                  Text(more).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                }
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .frame(maxWidth: 300)
              .background(Theme.chip, in: .capsule)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("running-chip")
          }
        }
        .padding(.horizontal, 16)
      }
      .padding(.bottom, 6)
      .sheet(item: $watching) { w in SubagentSheet(toolId: w.id, chat: chat, session: session) }
      .axContainer("running-strip")
    }
  }
}

/// What a plan that waits for review is answered with.
let proceedText = "Proceed"

/// A plan, a task list or a walkthrough the agent wrote (Antigravity's artifacts): its
/// title and summary, opened full screen by a tap. A plan that waits for a review offers Proceed.
struct DocumentCard: View {
  @Environment(AppModel.self) private var model
  let tool: ToolItem
  let doc: DocumentDetail
  let chat: ChatState
  let session: SessionInfo
  @State private var reading = false

  /// The agent's latest word asks for a review: nothing was sent after it, and it is not at work.
  private var waitsForReview: Bool {
    doc.requestFeedback == true && doc.text != nil && session.status == .idle && !chat.answered(after: tool.id)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        reading = true
      } label: {
        HStack(spacing: 12) {
          Image(systemName: "doc.text")
            .font(.body)
            .foregroundStyle(.secondary)
            .frame(width: 34, height: 34)
            .background(Theme.chip, in: .rect(cornerRadius: 10))
          VStack(alignment: .leading, spacing: 3) {
            Text(doc.title).font(.callout.weight(.semibold)).lineLimit(1)
            if let summary = doc.summary {
              Text(summary).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
          }
          Spacer(minLength: 0)
          if doc.text == nil {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.quaternary)
          }
        }
        .padding(12)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(doc.text == nil)
      .accessibilityIdentifier("document-open")
      if waitsForReview {
        Divider()
        HStack {
          Text("Waiting for your review").font(.footnote.weight(.medium)).foregroundStyle(Theme.attention)
          Spacer()
          Button(proceedText) {
            Haptics.play(.select)
            Task { await model.client.sendChat(session.id, text: proceedText) }
          }
          .buttonStyle(.graphitePrimary)
          .accessibilityIdentifier("document-proceed")
        }
        .padding(12)
      }
    }
    .background(Theme.card, in: .rect(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.hairline))
    .padding(.vertical, 4)
    .sheet(isPresented: $reading) { DocumentSheet(doc: doc) }
    .axContainer("chat-item-document")
  }
}

/// A document, full screen, as Markdown.
struct DocumentSheet: View {
  let doc: DocumentDetail
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          MarkdownView(text: doc.text ?? "")
          if doc.textTruncated == true {
            Text("The rest of this document is on your computer.").font(.footnote).foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
      }
      .navigationTitle(doc.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }.accessibilityIdentifier("document-close")
        }
      }
    }
    .axContainer("document-view")
  }
}

struct ToolStatusIcon: View {
  let status: ToolStatus

  var body: some View {
    switch status {
    case .running: ProgressView().controlSize(.mini)
    // Done is the ordinary case: only what is unusual gets a mark.
    case .done: EmptyView()
    case .error: Image(systemName: "xmark").foregroundStyle(.red).font(.caption.bold())
    case .denied: Image(systemName: "hand.raised").foregroundStyle(.orange).font(.caption.bold())
    default: EmptyView()
    }
  }
}

struct ToolDetailView: View {
  let tool: ToolItem
  let sessionId: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      switch tool.detail {
      case .command(let command, let cwd, let exitCode):
        CodeText("$ " + command, language: "bash")
        if let cwd { Text(cwd).font(.caption.monospaced()).foregroundStyle(.secondary) }
        if let out = tool.output, !out.isEmpty { OutputText(out, truncated: tool.outputTruncated == true) }
        if let exitCode, exitCode != 0 { Text("Exit code \(exitCode)").font(.caption).foregroundStyle(.red) }
      case .diff(let path, let patch, _, _):
        Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
        DiffView(patch: patch)
      case .file(let path, let content):
        Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
        if let content { CodeText(content, language: (path as NSString).pathExtension) }
        if let out = tool.output, !out.isEmpty, content == nil { OutputText(out, truncated: tool.outputTruncated == true) }
      case .todos(let todos):
        TodoList(todos: todos)
      case .search(let query, let path):
        Label(query, systemImage: "magnifyingglass").font(.callout.monospaced())
        if let path { Text(path).font(.caption.monospaced()).foregroundStyle(.secondary) }
        if let out = tool.output, !out.isEmpty { OutputText(out, truncated: tool.outputTruncated == true) }
      case .url(let url):
        if let u = URL(string: url) { Link(url, destination: u).font(.callout) } else { Text(url) }
        if let out = tool.output, !out.isEmpty { OutputText(out, truncated: tool.outputTruncated == true) }
      case .document(let d):
        // An earlier version of a document: the latest is the card further down.
        if let summary = d.summary { Text(summary).font(.callout).foregroundStyle(.secondary) }
        Text(d.path).font(.caption.monospaced()).foregroundStyle(.secondary)
      default:
        if let input = tool.input { OutputText(input.jsonText, truncated: false) }
        if let out = tool.output, !out.isEmpty { OutputText(out, truncated: tool.outputTruncated == true) }
      }
      if let images = tool.images, !images.isEmpty {
        ImageStrip(sessionId: sessionId, images: images)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct OutputText: View {
  let text: String
  let truncated: Bool
  init(_ text: String, truncated: Bool) {
    self.text = text
    self.truncated = truncated
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ScrollView([.horizontal, .vertical]) {
        Text(text)
          .font(.caption.monospaced())
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
      }
      .frame(maxHeight: 260)
      .fixedSize(horizontal: false, vertical: true)
      .background(.fill.tertiary, in: .rect(cornerRadius: 8))
      if truncated { Text("Output truncated").font(.caption2).foregroundStyle(.secondary) }
    }
  }
}

struct TodoList: View {
  let todos: [TodoEntry]

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("\(todos.filter { $0.status == "completed" }.count) of \(todos.count)")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("todo-progress")
      ForEach(Array(todos.enumerated()), id: \.offset) { _, t in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: t.status == "completed" ? "checkmark.circle.fill" : t.status == "in_progress" ? "circle.dotted" : "circle")
            .foregroundStyle(t.status == "completed" ? Color.green : t.status == "in_progress" ? Color.accentColor : Color.secondary)
          Text(t.text)
            .strikethrough(t.status == "completed")
            .foregroundStyle(t.status == "completed" ? .secondary : .primary)
        }
        .font(.callout)
      }
    }
  }
}

struct DiffView: View {
  let patch: String

  var body: some View {
    let lines = UnifiedDiff.lines(patch).filter { $0.kind != .meta }
    // As wide as its place when the lines fit (their tint then reaches the edge);
    // sideways scrolling only for a diff with longer lines.
    ViewThatFits(in: .horizontal) {
      rows(lines, fill: true)
      ScrollView(.horizontal) { rows(lines, fill: false) }
    }
    .background(.fill.tertiary, in: .rect(cornerRadius: 8))
    .clipShape(.rect(cornerRadius: 8))
    .axContainer("diff-view")
  }

  private func rows(_ lines: [DiffLine], fill: Bool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(lines) { l in
        HStack(spacing: 8) {
          Text(l.oldLine.map(String.init) ?? "").frame(width: 28, alignment: .trailing).foregroundStyle(.tertiary)
          Text(l.newLine.map(String.init) ?? "").frame(width: 28, alignment: .trailing).foregroundStyle(.tertiary)
          Text(prefix(l.kind) + l.text)
            .foregroundStyle(l.kind == .hunk ? Color.secondary : Color.primary)
            .fixedSize()
        }
        .font(.caption.monospaced())
        .padding(.vertical, 1)
        .padding(.trailing, 8)
        .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
        .background(background(l.kind))
      }
    }
  }

  private func prefix(_ k: DiffLine.Kind) -> String {
    switch k {
    case .added: "+ "
    case .removed: "- "
    case .context: "  "
    default: ""
    }
  }

  private func background(_ k: DiffLine.Kind) -> Color {
    switch k {
    case .added: Theme.diffAdd
    case .removed: Theme.diffDel
    case .hunk: Theme.diffHunk
    default: .clear
    }
  }
}

// MARK: - Asks

struct PermissionCard: View {
  @Environment(AppModel.self) private var model
  let item: PermissionItem
  let session: SessionInfo
  @State private var denying = false
  @State private var reason = ""

  private var verb: String {
    switch item.toolName {
    case "Bash": "run a command"
    case "Edit", "Write": "edit a file"
    default: "use \(item.toolName)"
    }
  }

  var body: some View {
    if item.status == "allowed" {
      // The command, edit or call it allowed is in the transcript as its own line.
      EmptyView()
    } else if !item.isPending {
      HStack(spacing: 6) {
        Image(systemName: item.status == "allowed" ? "checkmark" : "xmark")
        Text(item.status == "allowed" ? "Allowed" : item.status == "denied" ? "Denied" : "Cancelled")
        // The title already names the tool ("Bash: npm test").
        Text(item.title).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
      }
      .font(.footnote)
      .foregroundStyle(.secondary)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat-item-permission")
      .accessibilityValue(item.status)
    } else {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "checkmark.shield")
            .font(.title3)
            .foregroundStyle(Theme.attention)
          VStack(alignment: .leading, spacing: 2) {
            Text("\(Agents.shortLabel(session, model.client.host)) wants to \(verb)").font(.headline)
            Text(item.title).font(.callout.monospaced()).foregroundStyle(.secondary).lineLimit(3)
          }
        }
        preview
        if denying {
          TextField("Tell the agent what to do instead (optional)", text: $reason, axis: .vertical)
            .lineLimit(2...4)
            .padding(10)
            .background(.fill.tertiary, in: .rect(cornerRadius: 10))
            .accessibilityIdentifier("permission-deny-message")
          HStack {
            Button("Cancel") { denying = false }
              .buttonStyle(.graphite)
            Spacer()
            Button("Deny", role: .destructive) { decide(.deny, message: reason) }
              .buttonStyle(.graphitePrimary)
              .tint(.red)
              .accessibilityIdentifier("permission-deny-send")
          }
        } else {
          buttons
        }
      }
      .padding(14)
      .background(Theme.card, in: .rect(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.hairline))
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat-item-permission")
      .accessibilityValue("pending")
    }
  }

  @ViewBuilder
  /// Deny and Allow side by side (Allow, the common answer, is the one ink
  /// button); the rarer answers wait in a menu so the card stays one row.
  private var buttons: some View {
    HStack(spacing: 8) {
      if item.canDenyWithMessage != false || item.canAllowAlways == true {
        Menu {
          if item.canAllowAlways == true {
            Button("Always allow", systemImage: "checkmark.seal") { decide(.allowAlways) }
              .accessibilityIdentifier("permission-always")
          }
          if item.canDenyWithMessage != false {
            Button("Deny with a note…", systemImage: "text.bubble") { denying = true }
              .accessibilityIdentifier("permission-deny-note")
          }
        } label: {
          Image(systemName: "ellipsis")
            .frame(width: 18, height: 34)
            .graphiteChip()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("More answers")
        .accessibilityIdentifier("permission-more")
      }
      Spacer(minLength: 0)
      Button("Deny") { decide(.deny) }
        .buttonStyle(.graphite)
        .accessibilityIdentifier("permission-deny")
      Button("Allow") { decide(.allow) }
        .buttonStyle(.graphitePrimary)
        .accessibilityIdentifier("permission-allow")
    }
  }

  @ViewBuilder
  private var preview: some View {
    switch item.detail {
    case .command(let command, _, _): CodeText("$ " + command, language: "bash")
    case .diff(_, let patch, _, _): DiffView(patch: patch)
    case .file(let path, let content):
      VStack(alignment: .leading) {
        Text(path).font(.caption.monospaced()).foregroundStyle(.secondary)
        if let content { CodeText(String(content.prefix(4000)), language: (path as NSString).pathExtension) }
      }
    case .url(let u): Text(u).font(.callout.monospaced())
    default:
      if let input = item.input { OutputText(input.jsonText, truncated: false) }
    }
  }

  private func decide(_ d: PermissionDecision, message: String? = nil) {
    let m = message?.trimmingCharacters(in: .whitespacesAndNewlines)
    model.client.answerPermission(session.id, itemId: item.id, d, message: (m?.isEmpty ?? true) ? nil : m)
    Haptics.play(d == .deny ? .deny : .allow)
  }
}

struct QuestionCard: View {
  @Environment(AppModel.self) private var model
  let item: QuestionItem
  let session: SessionInfo
  @State private var picked: [Int: Set<String>] = [:]
  @State private var other: [Int: String] = [:]

  var body: some View {
    if !item.isPending {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(item.questions.enumerated()), id: \.offset) { _, q in
          Text(q.question).font(.footnote).foregroundStyle(.secondary)
          Text(item.answers?[q.question] ?? (item.status == "cancelled" ? "Cancelled" : "—"))
            .font(.callout.weight(.medium))
            .accessibilityIdentifier("question-answer")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat-item-question")
      .accessibilityValue(item.status)
    } else {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(Array(item.questions.enumerated()), id: \.offset) { i, q in
          VStack(alignment: .leading, spacing: 8) {
            if let h = q.header {
              Text(h.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }
            Text(q.question).font(.headline)
            ForEach(q.options, id: \.label) { o in
              let on = picked[i, default: []].contains(o.label)
              Button {
                toggle(i, o.label, multi: q.multiSelect == true)
              } label: {
                HStack(alignment: .top, spacing: 10) {
                  Image(systemName: q.multiSelect == true ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(on ? Color.accentColor : Color.secondary)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(o.label)
                    if let d = o.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                  }
                  Spacer(minLength: 0)
                }
                .padding(10)
                .background(on ? Color.accentColor.opacity(0.14) : Color.clear, in: .rect(cornerRadius: 10))
                .contentShape(.rect)
              }
              .buttonStyle(.plain)
              .accessibilityIdentifier("question-option")
            }
            TextField("Other…", text: Binding(get: { other[i] ?? "" }, set: { other[i] = $0 }))
              .padding(10)
              .background(.fill.tertiary, in: .rect(cornerRadius: 10))
          }
        }
        Button("Submit") { submit() }
          .buttonStyle(.graphitePrimary)
          .disabled(!ready)
          .accessibilityIdentifier("question-submit")
      }
      .padding(14)
      .background(Theme.card, in: .rect(cornerRadius: 18))
      .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.hairline))
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat-item-question")
      .accessibilityValue("pending")
    }
  }

  private var ready: Bool {
    item.questions.indices.allSatisfy { i in !(picked[i] ?? []).isEmpty || !(other[i] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
  }

  private func toggle(_ i: Int, _ label: String, multi: Bool) {
    var set = picked[i] ?? []
    if set.contains(label) { set.remove(label) } else {
      if !multi { set = [] }
      set.insert(label)
    }
    picked[i] = set
    Haptics.play(.select)
  }

  private func submit() {
    var answers: [String: String] = [:]
    for (i, q) in item.questions.enumerated() {
      let labels = q.options.map(\.label).filter { picked[i]?.contains($0) == true }
      let o = (other[i] ?? "").trimmingCharacters(in: .whitespaces)
      answers[q.question] = (labels + (o.isEmpty ? [] : [o])).joined(separator: ", ")
    }
    model.client.answerQuestion(session.id, itemId: item.id, answers: answers)
    Haptics.play(.allow)
  }
}
