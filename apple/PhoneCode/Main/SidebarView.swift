import PhoneCodeCore
import SwiftUI

/// The chat list: "Needs you" first, then the rest, newest activity first.
/// Search runs `history.list` across every harness on the computer.
struct SidebarView: View {
  @Environment(AppModel.self) private var model
  var onOpen: () -> Void = {}
  @State private var query = ""
  @State private var showComputer = false
  @State private var renaming: SessionInfo?
  @State private var renameText = ""
  @State private var deleting: SessionInfo?
  @FocusState private var searchFocused: Bool

  var body: some View {
    list
      .navigationTitle(Self.displayName(model.creds?.hostName))
      #if os(iOS)
        // Compact: the computer's name between the two buttons, not a
        // large title eating the top of the screen.
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .searchable(text: $query, placement: .sidebar, prompt: "Search all chats")
      .searchFocused($searchFocused)
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button {
            model.route = .new
            onOpen()
          } label: {
            Label("New chat", systemImage: "square.and.pencil")
          }
          #if os(iOS)
            .keyboardShortcut("n", modifiers: .command)
          #endif
          .accessibilityIdentifier("new-chat")
        }
        #if os(iOS)
          ToolbarItem(placement: .topBarLeading) {
            Button {
              showComputer = true
            } label: {
              Label("This computer", systemImage: "desktopcomputer")
            }
            .accessibilityIdentifier("open-computer")
          }
        #endif
      }
      .sheet(isPresented: $showComputer) {
        NavigationStack { ComputerView() }
          .presentationDetents([.medium, .large])
      }
      .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
        TextField("Title", text: $renameText)
          .accessibilityIdentifier("rename-field")
        Button("Save") {
          if let s = renaming { model.rename(s, to: renameText) }
          renaming = nil
        }
        .accessibilityIdentifier("rename-save")
        Button("Cancel", role: .cancel) { renaming = nil }
      }
      .confirmationDialog(
        "Delete “\(deleting?.title ?? "")”?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
        titleVisibility: .visible
      ) {
        Button("Delete", role: .destructive) {
          if let s = deleting { model.delete(s) }
          deleting = nil
        }
      } message: {
        Text(deleting?.isTerminal == true ? "The shell and anything running in it will be stopped." : "The agent process on your computer will be stopped.")
      }
      .onReceive(NotificationCenter.default.publisher(for: .focusSearch)) { _ in searchFocused = true }
  }

  @ViewBuilder
  private var list: some View {
    if !query.trimmingCharacters(in: .whitespaces).isEmpty {
      SearchResultsView(query: query, onOpen: onOpen)
    } else {
      let groups = model.client.sidebar
      List {
        if !groups.needsYou.isEmpty {
          Section {
            ForEach(groups.needsYou) { row($0) }
          } header: {
            Label("Needs you", systemImage: "bell.badge.fill")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(Theme.attention)
          }
          .axContainer("section-needs-you")
        }
        Section {
          ForEach(groups.chats) { row($0) }
        } header: {
          if !groups.needsYou.isEmpty { Text("Chats").font(.footnote.weight(.semibold)) }
        }
      }
      .listStyle(.sidebar)
      #if os(iOS)
        .listSectionSpacing(.compact)
      #endif
      .overlay {
        if model.client.sessionsLoaded && groups.needsYou.isEmpty && groups.chats.isEmpty {
          ContentUnavailableView("No chats yet", systemImage: "bubble.left.and.text.bubble.right", description: Text("Start one with the composer."))
        } else if !model.client.sessionsLoaded {
          ProgressView()
        }
      }
      .axContainer("sidebar")
    }
  }

  private func open(_ s: SessionInfo) {
    model.route = .session(s.id)
    Haptics.play(.select)
    onOpen()
  }

  /// iPhone: a button. Mac: a row that opens on click and can be dragged onto
  /// the workspace (a Button there takes the mouse-down, so no drag starts).
  @ViewBuilder
  private func rowBody(_ s: SessionInfo, selected: Bool) -> some View {
    #if os(macOS)
      SessionRow(session: s, selected: selected)
        .contentShape(.rect)
        .onTapGesture { open(s) }
        .workspaceDraggable(.session(s.id), title: s.title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { open(s) }
    #else
      Button {
        open(s)
      } label: {
        SessionRow(session: s, selected: selected)
      }
      .buttonStyle(.plain)
    #endif
  }

  private func row(_ s: SessionInfo) -> some View {
    let selected = model.route == .session(s.id)
    return rowBody(s, selected: selected)
    .listRowBackground(
      RoundedRectangle(cornerRadius: 10)
        .fill(selected ? Theme.selection : .clear)
        .padding(.horizontal, 6)
    )
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button {
        model.archive(s)
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      .tint(.indigo)
    }
    .contextMenu {
      Button {
        renameText = s.title
        renaming = s
      } label: {
        Label("Rename", systemImage: "pencil")
      }
      Button {
        model.archive(s)
      } label: {
        Label("Archive", systemImage: "archivebox")
      }
      if let text = model.client.chat(s.id).lastResponse {
        Button {
          Clipboard.copy(text)
          model.show("Copied")
        } label: {
          Label("Copy last response", systemImage: "doc.on.doc")
        }
      }
      Divider()
      Button(role: .destructive) {
        deleting = s
      } label: {
        Label("Delete", systemImage: "trash")
      }
    }
    .accessibilityIdentifier("session-row")
  }
}

extension SidebarView {
  /// "Sloans-MacBook-Pro.local" reads as "Sloans-MacBook-Pro".
  static func displayName(_ host: String?) -> String {
    guard let host, !host.isEmpty else { return "phone-code" }
    return host.hasSuffix(".local") ? String(host.dropLast(6)) : host
  }
}

struct SessionRow: View {
  @Environment(AppModel.self) private var model
  let session: SessionInfo
  var selected = false

  // The web app's row: 15pt title, 14pt preview. iOS's body/subheadline
  // (17/15) read a size too big; the Mac's (13/11) already fit.
  #if os(iOS)
    static let titleFont = Font.subheadline
    static let previewFont = Font.footnote
  #else
    static let titleFont = Font.body
    static let previewFont = Font.subheadline
  #endif

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      HarnessGlyph(id: session.isTerminal ? "terminal" : (session.agent ?? "claude"), size: 28)
        .overlay(alignment: .topTrailing) {
          if session.isUnread && !selected {
            Circle().fill(Theme.ink).frame(width: 8, height: 8).offset(x: 3, y: -3)
          }
        }
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(session.title)
            .font(Self.titleFont.weight(session.isUnread || selected ? .semibold : .medium))
            .lineLimit(1)
          Spacer(minLength: 4)
          Text(Date.short(session.updatedAt))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        HStack(spacing: 6) {
          StatusDot(status: session.status)
          Text(session.preview.map(Markdown.plain) ?? tildePath(session.cwd, home: model.client.host?.home))
            .font(Self.previewFont)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
    }
    .padding(.vertical, 4)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
  }
}

struct StatusDot: View {
  let status: SessionStatus

  var body: some View {
    switch status {
    case .running:
      ProgressView().controlSize(.mini)
    case .waiting:
      Image(systemName: "hand.raised.fill").font(.caption2).foregroundStyle(Theme.attention)
    case .error:
      Image(systemName: "exclamationmark.triangle.fill").font(.caption2).foregroundStyle(.red)
    default:
      EmptyView()
    }
  }
}

/// An agent as a monogram on a quiet gray tile ("CC", "Cx", "Ge"): Graphite
/// has no brand colors, and look-alike logos read as fake. The terminal is
/// the app's own mark, a prompt on an ink tile.
struct HarnessGlyph: View {
  let id: String
  var size: CGFloat = 30

  static func monogram(_ id: String) -> String {
    switch id {
    case "claude": "CC"
    case "codex": "Cx"
    case "gemini": "Ge"
    case "opencode": "Oc"
    case "copilot": "Co"
    default: String(id.prefix(2)).capitalized
    }
  }

  var body: some View {
    if id == "terminal" {
      AppMark(size: size)
    } else {
      RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        .fill(Theme.chip)
        .overlay {
          Text(Self.monogram(id))
            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
            .foregroundStyle(.secondary)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
  }
}

/// What a chat looks like while it is dragged onto the workspace.
struct DragCard: View {
  let title: String

  var body: some View {
    Label(title, systemImage: "rectangle.on.rectangle")
      .font(.callout.weight(.medium))
      .lineLimit(1)
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .background(Theme.card, in: .capsule)
      .overlay(Capsule().strokeBorder(Theme.hairline))
      .frame(maxWidth: 280)
  }
}

/// phone-code's mark: a prompt on an ink tile (the app icon, at any size).
struct AppMark: View {
  var size: CGFloat = 30

  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
      // Near-black in light and dark mode alike, like the app icon.
      .fill(LinearGradient(colors: [Color(hex: 0x2A2A2E), Color(hex: 0x0C0C0E)], startPoint: .top, endPoint: .bottom))
      .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).strokeBorder(Theme.hairline))
      .overlay {
        Text(">_")
          .font(.system(size: size * 0.4, weight: .bold, design: .monospaced))
          .foregroundStyle(.white)
          .offset(y: -size * 0.02)
      }
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

/// "All chats": every conversation on the computer, from every harness.
struct SearchResultsView: View {
  @Environment(AppModel.self) private var model
  let query: String
  var onOpen: () -> Void
  @State private var results: [ResumableSession] = []
  @State private var loading = true
  @State private var error: String?

  var body: some View {
    List(results) { r in
      Button {
        Task {
          await model.open(r)
          onOpen()
        }
      } label: {
        HStack(alignment: .top, spacing: 12) {
          HarnessGlyph(id: r.agent)
          VStack(alignment: .leading, spacing: 3) {
            HStack {
              Text(r.title).lineLimit(1)
              if r.archived == true {
                Text("Archived").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2).background(.fill.tertiary, in: .capsule)
              }
              Spacer()
              Text(Date.short(r.updatedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Text("\(r.agentName ?? r.agent) · \(tildePath(r.cwd, home: model.client.host?.home))")
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
            if let s = r.snippet {
              Text(s).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
          }
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("search-result")
    }
    .listStyle(.sidebar)
    .overlay {
      if loading && results.isEmpty {
        ProgressView()
      } else if let error {
        ContentUnavailableView("Search failed", systemImage: "exclamationmark.magnifyingglass", description: Text(error))
      } else if results.isEmpty {
        ContentUnavailableView.search(text: query)
      }
    }
    .task(id: query) {
      loading = true
      try? await Task.sleep(for: .milliseconds(250))
      if Task.isCancelled { return }
      do {
        results = try await model.client.history(HistoryQuery(text: query, limit: 50))
        error = nil
      } catch {
        self.error = "\(error)"
      }
      loading = false
    }
    .axContainer("search-results")
  }
}

extension Notification.Name {
  static let focusSearch = Notification.Name("pc.focusSearch")
}

/// What a drag from the sidebar or a tile's title bar carries.
enum DragPayload {
  case session(String)
  case tile(String)

  var string: String {
    switch self {
    case .session(let id): "phonecode-session:\(id)"
    case .tile(let id): "phonecode-tile:\(id)"
    }
  }

  init?(_ s: String) {
    if s.hasPrefix("phonecode-session:") {
      self = .session(String(s.dropFirst("phonecode-session:".count)))
    } else if s.hasPrefix("phonecode-tile:") {
      self = .tile(String(s.dropFirst("phonecode-tile:".count)))
    } else {
      return nil
    }
  }
}
