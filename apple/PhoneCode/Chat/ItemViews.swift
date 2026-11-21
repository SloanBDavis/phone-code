import PhoneCodeCore
import SwiftUI

/// One transcript row. It reads only its own `ItemBox`, so streaming text
/// re-renders this row and nothing else.
struct ItemRow: View {
  let box: ItemBox
  let chat: ChatState
  let session: SessionInfo

  var body: some View {
    switch box.item {
    case .user(let u): UserBubble(item: u, sessionId: session.id)
    case .text(let t): AssistantText(item: t, sessionId: session.id)
    case .thinking(let t): ThinkingRow(item: t)
    case .tool(let t): ToolCard(tool: t, chat: chat, session: session)
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
          .background(Color.accentColor.opacity(0.2), in: .rect(cornerRadius: 20))
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
        .background(Color.accentColor.opacity(0.12), in: .rect(cornerRadius: 20))
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
      HStack(spacing: 6) {
        Image(systemName: "brain")
        Text(item.streaming ? "Thinking…" : "Thought")
      }
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
        withAnimation(.snappy) { open = !expanded }
      } label: {
        HStack(spacing: 10) {
          Image(systemName: Self.symbol(tool.name))
            .frame(width: 20)
            .foregroundStyle(.secondary)
          Text(tool.title.isEmpty ? tool.name : tool.title)
            .font(tool.name == "Bash" ? .callout.monospaced() : .callout)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 6)
          if case .diff(_, _, let added, let removed) = tool.detail {
            Text("+\(added)").foregroundStyle(.green).font(.caption.monospaced())
            Text("−\(removed)").foregroundStyle(.red).font(.caption.monospaced())
          }
          ToolStatusIcon(status: tool.status)
          Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if expanded {
        Divider()
        ToolDetailView(tool: tool, sessionId: session.id)
          .padding(12)
      } else if let images = tool.images, !images.isEmpty {
        ImageStrip(sessionId: session.id, images: images)
          .padding([.horizontal, .bottom], 12)
      }
      let kids = chat.children[tool.id] ?? []
      if !kids.isEmpty {
        Divider()
        VStack(alignment: .leading, spacing: 6) {
          ForEach(kids, id: \.self) { id in
            if let b = chat.box(id) {
              ItemRow(box: b, chat: chat, session: session)
            }
          }
        }
        .padding(10)
      }
    }
    .background(.fill.quinary, in: .rect(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.separator.opacity(0.5)))
    .axContainer("chat-item-tool")
  }

  static func symbol(_ name: String) -> String {
    switch name {
    case "Bash": "terminal"
    case "Read": "doc.text"
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

struct ToolStatusIcon: View {
  let status: ToolStatus

  var body: some View {
    switch status {
    case .running: ProgressView().controlSize(.small)
    case .done: Image(systemName: "checkmark").foregroundStyle(.green).font(.caption.bold())
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
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(lines) { l in
          HStack(spacing: 8) {
            Text(l.oldLine.map(String.init) ?? "").frame(width: 30, alignment: .trailing).foregroundStyle(.tertiary)
            Text(l.newLine.map(String.init) ?? "").frame(width: 30, alignment: .trailing).foregroundStyle(.tertiary)
            Text(prefix(l.kind) + l.text)
              .foregroundStyle(l.kind == .hunk ? Color.secondary : Color.primary)
          }
          .font(.caption.monospaced())
          .padding(.vertical, 1)
          .padding(.trailing, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(background(l.kind))
        }
      }
    }
    .background(.fill.tertiary, in: .rect(cornerRadius: 8))
    .clipShape(.rect(cornerRadius: 8))
    .axContainer("diff-view")
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
    case .added: .green.opacity(0.16)
    case .removed: .red.opacity(0.16)
    case .hunk: .blue.opacity(0.08)
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
    if !item.isPending {
      HStack(spacing: 6) {
        Image(systemName: item.status == "allowed" ? "checkmark" : "xmark")
        Text(item.status == "allowed" ? "Allowed" : item.status == "denied" ? "Denied" : "Cancelled")
        Text(item.toolName).bold()
        Text(item.title).font(.caption.monospaced()).lineLimit(1)
      }
      .font(.footnote)
      .foregroundStyle(.secondary)
      .accessibilityIdentifier("chat-item-permission")
      .accessibilityValue(item.status)
    } else {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "checkmark.shield")
            .font(.title3)
            .foregroundStyle(.orange)
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
              .buttonStyle(.glass)
            Spacer()
            Button("Deny", role: .destructive) { decide(.deny, message: reason) }
              .buttonStyle(.glassProminent)
              .tint(.red)
              .accessibilityIdentifier("permission-deny-send")
          }
        } else {
          ViewThatFits(in: .horizontal) {
            HStack { buttons }
            VStack(alignment: .leading) { buttons }
          }
        }
      }
      .padding(14)
      .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 18))
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat-item-permission")
      .accessibilityValue("pending")
    }
  }

  @ViewBuilder
  private var buttons: some View {
    Button("Deny") { decide(.deny) }
      .buttonStyle(.glass)
      .accessibilityIdentifier("permission-deny")
    if item.canDenyWithMessage != false {
      Button("Deny with note…") { denying = true }
        .buttonStyle(.glass)
        .accessibilityIdentifier("permission-deny-note")
    }
    if item.canAllowAlways == true {
      Button("Always allow") { decide(.allowAlways) }
        .buttonStyle(.glass)
        .accessibilityIdentifier("permission-always")
    }
    Button("Allow") { decide(.allow) }
      .buttonStyle(.glassProminent)
      .accessibilityIdentifier("permission-allow")
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
          .buttonStyle(.glassProminent)
          .disabled(!ready)
          .accessibilityIdentifier("question-submit")
      }
      .padding(14)
      .glassEffect(.regular.tint(Color.accentColor.opacity(0.10)), in: .rect(cornerRadius: 18))
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
