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

struct NewChatView: View {
  @Environment(AppModel.self) private var model
  var embedded = false
  @State private var starter: String?

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
          .frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.center)
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
        HarnessGlyph(id: "terminal", size: 58)
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
        .buttonStyle(.glass)
      } else {
        HarnessGlyph(id: d.harness, size: 58)
        Text(info?.name ?? "New chat")
          .font(.title2.bold())
        Text("in \(tildePath(d.cwd, home: model.client.host?.home)) on \(model.client.host?.name ?? "your computer")")
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
                .buttonStyle(.glass)
                .accessibilityIdentifier("starter")
            }
          }
          .padding(.top, 10)
        }
      }
    }
    .frame(maxWidth: 520)
    .axContainer("new-chat-empty")
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

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
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
        }
        if session.status == .running {
          WorkingIndicator()
        }
        Color.clear.frame(height: 4).id("bottom")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .frame(maxWidth: 860)
      .frame(maxWidth: .infinity)
    }
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
    .overlay {
      if !chat.loaded {
        ProgressView()
      }
    }
    .axContainer("transcript")
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
