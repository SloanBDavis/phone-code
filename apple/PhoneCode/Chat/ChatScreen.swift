import PhoneCodeCore
import SwiftUI

/// The main pane for a route: a new chat, a chat, or a terminal.
struct ChatScreen: View {
  @Environment(AppModel.self) private var model
  let route: Route
  /// Inside a Mac tile the tile draws its own title bar.
  var embedded = false

  var body: some View {
    switch route {
    case .new:
      NewChatView(embedded: embedded)
    case .session(let id):
      if let s = model.client.session(id) {
        if s.isTerminal {
          TerminalScreen(session: s, embedded: embedded)
        } else {
          ChatView(session: s, embedded: embedded)
        }
      } else if !model.client.sessionsLoaded {
        ProgressView("Loading…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        NewChatView(embedded: embedded)
      }
    }
  }
}

/// A scroll view's height without its insets (the toolbar's, the keyboard's).
func visibleHeight(_ g: ScrollGeometry) -> CGFloat {
  max(0, g.containerSize.height - g.contentInsets.top - g.contentInsets.bottom)
}

struct NewChatView: View {
  @Environment(AppModel.self) private var model
  var embedded = false
  @State private var starter: String?
  /// The visible height: the content fills it (see TranscriptView).
  @State private var viewport: CGFloat = 0

  static let starters = [
    "Explain how this project is organized",
    "Find and fix a failing test",
    "Review my uncommitted changes",
  ]

  var body: some View {
    VStack(spacing: 0) {
      ConnectionBanner()
      ScrollView {
        empty
          .padding(24)
          .frame(maxWidth: .infinity, minHeight: viewport)
      }
      .scrollEdgeEffectStyle(.soft, for: .top)
      .onScrollGeometryChange(for: CGFloat.self) { visibleHeight($0) } action: { _, h in viewport = h }
      if let s = model.client.starting {
        PendingBubble(pending: s, onRetry: nil)
          .padding(.horizontal)
      }
      ComposerView(mode: .new, prefill: $starter)
    }
    .background(Color.appBackground)
    #if os(iOS)
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .axContainer("screen-new-chat")
  }

  @ViewBuilder
  private var empty: some View {
    let d = model.draft
    let agents = Agents.catalog(model.client.host)
    let info = agents.first { $0.id == d.harness }
    VStack(spacing: 14) {
      if model.client.host != nil, !agents.contains(where: \.available) {
        AppMark(size: 56)
        Text("No coding agent on \(model.client.host?.name ?? "your computer") yet")
          .font(.title2.bold())
          .multilineTextAlignment(.center)
        Text("Install one on your computer and it shows up here. Meanwhile, the terminal works.")
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        ForEach(agents.filter { !$0.available }) { a in
          VStack(alignment: .leading) {
            Text(a.name).bold()
            Text(a.setupHint ?? "Not installed").font(.callout).foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("Open a terminal", systemImage: "apple.terminal") {
          Task { await model.openTerminal() }
        }
        .buttonStyle(.graphite)
      } else {
        AppMark(size: 56)
        Text(info?.name ?? "New chat")
          .font(.title2.bold())
        Text("in \(tildePath(d.cwd, home: model.client.host?.home)) on \(SidebarView.displayName(model.client.host?.name))")
          .font(.callout)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        if let info, !info.available || info.setupHint != nil {
          Label(info.setupHint ?? "Not installed on this computer.", systemImage: "exclamationmark.triangle")
            .font(.callout)
            .foregroundStyle(.orange)
            .accessibilityIdentifier("harness-hint")
        }
        if info?.available != false {
          VStack(spacing: 10) {
            ForEach(Self.starters, id: \.self) { s in
              Button(s) { starter = s }
                .buttonStyle(.graphite)
                .accessibilityIdentifier("starter")
            }
          }
          .padding(.top, 10)
        }
        CursorSuggestion()
          .padding(.top, 18)
      }
    }
    .frame(maxWidth: 520)
    .axContainer("new-chat-empty")
  }
}

/// For someone who has Cursor but has not connected it: one line offering it,
/// once (it can be dismissed; the switch also lives in This computer).
struct CursorSuggestion: View {
  @Environment(AppModel.self) private var model
  @AppStorage("pc.cursorSuggestionDismissed") private var dismissed = false
  @State private var busy = false

  var body: some View {
    if let c = model.client.host?.cursor, c.installed, !c.connected, !dismissed {
      HStack(spacing: 10) {
        HarnessGlyph(id: "cursor-app", size: 26)
        VStack(alignment: .leading, spacing: 1) {
          Text("Follow your Cursor chats here").font(.subheadline.weight(.medium))
          Text("See them live and reply when a turn ends.").font(.footnote).foregroundStyle(.secondary)
        }
        Spacer(minLength: 8)
        Button("Connect") {
          busy = true
          Task {
            _ = try? await model.client.setCursorConnected(true)
            busy = false
          }
        }
        .buttonStyle(.graphitePrimary)
        .controlSize(.small)
        .disabled(busy)
        .accessibilityIdentifier("cursor-connect")
        Button {
          dismissed = true
        } label: {
          Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Not now")
      }
      .padding(12)
      .background(Theme.card, in: .rect(cornerRadius: 16, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.hairline))
      .frame(maxWidth: 440)
      .axContainer("cursor-suggestion")
    }
  }
}

/// A chat: the transcript, the asks it is waiting on, and the composer.
struct ChatView: View {
  @Environment(AppModel.self) private var model
  let session: SessionInfo
  var embedded = false
  @State private var prefill: String?
  @State private var showInfo = false

  var body: some View {
    let chat = model.client.chat(session.id)
    VStack(spacing: 0) {
      ConnectionBanner()
      TranscriptView(chat: chat, session: session)
      RunningStrip(chat: chat, session: session)
      ComposerView(mode: .session(session), prefill: $prefill)
    }
    .background(Color.appBackground)
    .task(id: session.id) {
      model.client.subscribe(session.id)
      model.visibleSessions.insert(session.id)
    }
    .onDisappear {
      model.client.unsubscribe(session.id)
      model.visibleSessions.remove(session.id)
    }
    #if os(iOS)
      .navigationTitle(session.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { titleMenu }
      }
    #endif
    .axContainer("screen-chat")
  }

  private var titleMenu: some View {
    Menu {
      Text("\(Agents.label(session, model.client.host)) · \(tildePath(session.cwd, home: model.client.host?.home))")
      if let text = model.client.chat(session.id).lastResponse {
        Button("Copy last response", systemImage: "doc.on.doc") {
          Clipboard.copy(text)
          model.show("Copied")
        }
        ShareLink(item: text) { Label("Share last response", systemImage: "square.and.arrow.up") }
      }
      Button("Archive", systemImage: "archivebox") { model.archive(session) }
      Button("Delete", systemImage: "trash", role: .destructive) { model.delete(session) }
    } label: {
      Label("Chat options", systemImage: "ellipsis")
    }
    .accessibilityIdentifier("chat-menu")
  }
}

/// The transcript. Each row observes only its own item, so a streaming delta
/// redraws one row; the list stays pinned to the bottom while it grows.
struct TranscriptView: View {
  @Environment(AppModel.self) private var model
  let chat: ChatState
  let session: SessionInfo
  @State private var position = ScrollPosition(edge: .bottom)
  /// Whether the reader is at (or near) the end; new items only pull the
  /// view down then, so scrolling up to read is never interrupted.
  @State private var atBottom = true
  /// The visible height: the content is at least this tall, so a short chat
  /// still fills the view (its messages at the bottom).
  @State private var viewport: CGFloat = 0
  /// A document opened from a link to it in the chat.
  @State private var linkedDocument: DocumentDetail?

  /// Above this many rows the transcript is built lazily.
  private static let lazyAbove = 300

  @ViewBuilder
  private var rows: some View {
    ForEach(chat.ids, id: \.self) { id in
      if let box = chat.box(id) {
        ItemRow(box: box, chat: chat, session: session)
          .id(id)
      }
    }
    ForEach(chat.pending) { p in
      PendingBubble(pending: p) {
        Task { await model.client.retrySend(session.id, localId: p.localId) }
      }
      .padding(.vertical, 8)
    }
    if session.status == .running {
      WorkingIndicator()
        .padding(.vertical, 8)
    }
    Color.clear.frame(height: 4).id("bottom")
  }

  var body: some View {
    ScrollView {
      // A long transcript builds its rows as they come into view. A shorter one is
      // laid out whole: every row's height is known, so scrolling never jumps while
      // heights are being found out.
      Group {
        if chat.ids.count > Self.lazyAbove {
          LazyVStack(alignment: .leading, spacing: 0) { rows }
        } else {
          VStack(alignment: .leading, spacing: 0) { rows }
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
      // Fill the view even when the chat is short: the empty top of a scroll
      // view under the toolbar is drawn in the toolbar's color on macOS.
      .frame(maxWidth: .infinity, minHeight: viewport, alignment: .bottom)
    }
    .scrollPosition($position)
    .scrollEdgeEffectStyle(.soft, for: .top)
    .onScrollGeometryChange(for: CGFloat.self) { visibleHeight($0) } action: { _, h in
      viewport = h
    }
    .defaultScrollAnchor(.bottom)
    // New content keeps the end in view only while the reader is there: scrolled up,
    // what they read stays put as the answer grows below it.
    .defaultScrollAnchor(atBottom ? .bottom : .top, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { g in
      g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 8
    } action: { _, near in
      atBottom = near
    }
    // A finger moving the transcript: it is the reader's while it moves, and follows
    // again if it comes to rest at the end.
    .onScrollPhaseChange { _, phase, context in
      if phase == .interacting {
        atBottom = false
      } else if phase == .idle {
        let g = context.geometry
        atBottom = g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 8
      }
    }
    // Follow new items (an answer, a permission, a question) while at the
    // end, and always after the user sends.
    .onChange(of: chat.ids.last) { _, _ in
      if atBottom { scrollToEnd() }
    }
    .onChange(of: chat.pending.count) { old, new in
      if new > old { scrollToEnd() }
    }
    .onChange(of: session.status) { _, _ in
      if atBottom { scrollToEnd() }
    }
    .overlay {
      if !chat.loaded {
        ProgressView()
      }
    }
    // A link to a Markdown file on the computer (a plan the agent wrote) opens that
    // document, when the chat has it; other links go to the system.
    .environment(
      \.openURL,
      OpenURLAction { url in
        guard url.isFileURL, ["md", "markdown"].contains(url.pathExtension.lowercased()) else { return .systemAction }
        if let found = chat.latestDocument(url.path), found.doc.text != nil {
          linkedDocument = found.doc
        } else {
          model.show("That file is on your computer")
        }
        return .handled
      }
    )
    .sheet(item: $linkedDocument) { DocumentSheet(doc: $0) }
    .axContainer("transcript")
  }
}

extension TranscriptView {
  private func scrollToEnd() {
    // After layout, so the new row has a height.
    Task { @MainActor in
      withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
    }
  }
}

struct WorkingIndicator: View {
  var body: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text("Working…").font(.footnote).foregroundStyle(.secondary)
    }
    .padding(.vertical, 4)
    .axContainer("working")
  }
}
