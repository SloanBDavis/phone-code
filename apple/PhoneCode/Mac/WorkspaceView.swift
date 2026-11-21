#if os(macOS)
  import AppKit
  import PhoneCodeCore
  import SwiftUI
  import UniformTypeIdentifiers

  /// One window's tiling layout (PhoneCodeCore's `Workspace` split tree), saved per window.
  @MainActor @Observable
  final class WorkspaceStore {
    var layout: Workspace {
      didSet { if layout != oldValue { onChange?(layout) } }
    }
    @ObservationIgnored var onChange: ((Workspace) -> Void)?

    init(_ layout: Workspace) { self.layout = layout }

    var focusedSessionId: String? { layout.focusedTile?.sessionId }

    func newChat() { layout.open(nil) }

    func splitFocused(_ edge: Workspace.Edge) {
      layout.drop(nil, onto: layout.focused, edge: edge)
    }

    func closeFocused() { layout.close(layout.focused) }
    func focusNext() { layout.focusNext() }
    func focusPrevious() { layout.focusPrevious() }

    static let defaultsKey = "pc.workspace"

    static func restore(_ data: Data?) -> Workspace {
      if let data, let w = try? JSONDecoder().decode(Workspace.self, from: data) { return w }
      if let d = UserDefaults.standard.data(forKey: defaultsKey), let w = try? JSONDecoder().decode(Workspace.self, from: d) {
        return w
      }
      return Workspace()
    }
  }

  extension FocusedValues {
    @Entry var workspace: WorkspaceStore?
  }

  /// The Mac window: the sidebar, and several sessions side by side.
  struct MacMainView: View {
    @Environment(AppModel.self) private var model
    @SceneStorage("pc.workspace.layout") private var saved: Data?
    @State private var store = WorkspaceStore(Workspace())
    @State private var loaded = false
    @State private var columns: NavigationSplitViewVisibility = .all

    var body: some View {
      NavigationSplitView(columnVisibility: $columns) {
        SidebarView()
          .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 400)
      } detail: {
        WorkspaceView(store: store)
          .navigationTitle(model.client.session(store.focusedSessionId ?? "")?.title ?? "New chat")
          .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
              Button("Split right", systemImage: "rectangle.split.2x1") { store.splitFocused(.right) }
                .help("Split right (⌘D)")
                .accessibilityIdentifier("split-right")
              Button("Split down", systemImage: "rectangle.split.1x2") { store.splitFocused(.bottom) }
                .help("Split down (⇧⌘D)")
                .accessibilityIdentifier("split-down")
              SettingsLink {
                Label("This computer", systemImage: "desktopcomputer")
              }
              .accessibilityIdentifier("open-computer")
            }
          }
      }
      .focusedSceneValue(\.workspace, store)
      .onAppear {
        guard !loaded else { return }
        loaded = true
        store.layout = WorkspaceStore.restore(saved)
        store.onChange = { w in
          let d = try? JSONEncoder().encode(w)
          saved = d
          UserDefaults.standard.set(d, forKey: WorkspaceStore.defaultsKey)
        }
        syncRoute()
      }
      .onChange(of: model.route) { _, r in
        if store.focusedSessionId != r.sessionId { store.layout.open(r.sessionId) }
      }
      .onChange(of: store.layout.focused) { _, _ in syncRoute() }
      .onChange(of: model.client.sessions.filter { !$0.isArchived }.map(\.id)) { _, ids in
        // Sessions deleted or archived (here or on another device) leave the layout.
        guard model.client.sessionsLoaded else { return }
        store.layout.prune(keeping: Set(ids))
      }
    }

    private func syncRoute() {
      let r: Route = store.focusedSessionId.map { .session($0) } ?? .new
      if model.route != r { model.route = r }
    }
  }

  struct WorkspaceView: View {
    let store: WorkspaceStore

    var body: some View {
      NodeView(node: store.layout.root, store: store)
        .axContainer("workspace")
    }
  }

  struct NodeView: View {
    let node: Workspace.Node
    let store: WorkspaceStore

    var body: some View {
      if node.isLeaf {
        TileView(tile: node, store: store)
      } else {
        SplitNodeView(node: node, store: store)
      }
    }
  }

  /// Two children with a draggable divider between them.
  struct SplitNodeView: View {
    let node: Workspace.Node
    let store: WorkspaceStore
    @State private var dragStart: Double?

    var body: some View {
      GeometryReader { geo in
        let horizontal = node.axis == .horizontal
        let total = horizontal ? geo.size.width : geo.size.height
        let first = max(0, total * node.ratio - 3)
        let layout = horizontal ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
        layout {
          NodeView(node: node.children[0], store: store)
            .frame(width: horizontal ? first : nil, height: horizontal ? nil : first)
          divider(horizontal: horizontal, total: total)
          NodeView(node: node.children[1], store: store)
        }
      }
    }

    private func divider(horizontal: Bool, total: Double) -> some View {
      Rectangle()
        .fill(Color(nsColor: .separatorColor))
        .frame(width: horizontal ? 1 : nil, height: horizontal ? nil : 1)
        .padding(horizontal ? .horizontal : .vertical, 2.5)
        .contentShape(.rect)
        .onHover { inside in
          if inside { (horizontal ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push() } else { NSCursor.pop() }
        }
        .gesture(
          DragGesture(minimumDistance: 1)
            .onChanged { v in
              let start = dragStart ?? node.ratio
              if dragStart == nil { dragStart = start }
              let delta = (horizontal ? v.translation.width : v.translation.height) / max(total, 1)
              store.layout.setRatio(node.id, start + delta)
            }
            .onEnded { _ in dragStart = nil }
        )
        .accessibilityIdentifier("tile-divider")
    }
  }

  /// One tile: a title bar you can drag, the session, and drop zones on its edges.
  struct TileView: View {
    @Environment(AppModel.self) private var model
    let tile: Workspace.Node
    let store: WorkspaceStore
    @State private var target: Workspace.Edge?
    @State private var size: CGSize = .zero

    private var focused: Bool { store.layout.focused == tile.id }
    private var route: Route { tile.sessionId.map { .session($0) } ?? .new }

    var body: some View {
      VStack(spacing: 0) {
        titleBar
        ChatScreen(route: route, embedded: true)
          .id(route)
      }
      .background(Color.appBackground)
      .overlay {
        if store.layout.tiles.count > 1 {
          RoundedRectangle(cornerRadius: 0)
            .strokeBorder(focused ? Color.accentColor.opacity(0.7) : .clear, lineWidth: 1.5)
            .allowsHitTesting(false)
        }
      }
      .overlay { dropHighlight.allowsHitTesting(false) }
      .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
      .onDrop(of: [.text], delegate: TileDropDelegate(tile: tile, store: store, size: size, target: $target))
      .simultaneousGesture(TapGesture().onEnded { store.layout.focus(tile.id) })
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tile")
    }

    private var titleBar: some View {
      let s = tile.sessionId.flatMap { model.client.session($0) }
      return HStack(spacing: 8) {
        HarnessGlyph(id: s.map { $0.isTerminal ? "terminal" : ($0.agent ?? "claude") } ?? model.draft.harness, size: 20)
        Text(s?.title ?? "New chat")
          .font(.callout.weight(focused ? .semibold : .regular))
          .lineLimit(1)
        if let s { StatusDot(status: s.status) }
        Spacer()
        Menu {
          Button("Split right", systemImage: "rectangle.split.2x1") { store.layout.drop(nil, onto: tile.id, edge: .right) }
          Button("Split down", systemImage: "rectangle.split.1x2") { store.layout.drop(nil, onto: tile.id, edge: .bottom) }
          if let s {
            Divider()
            Button("Archive", systemImage: "archivebox") { model.archive(s) }
          }
        } label: {
          Image(systemName: "ellipsis")
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        Button {
          store.layout.close(tile.id)
        } label: {
          Image(systemName: "xmark")
        }
        .buttonStyle(.borderless)
        .help("Close tile (⌃⌘W)")
        .accessibilityIdentifier("tile-close")
      }
      .padding(.horizontal, 10)
      .frame(height: 30)
      .background(focused ? Color.accentColor.opacity(0.08) : Color.clear)
      .contentShape(.rect)
      .draggable(DragPayload.tile(tile.id).string) {
        Label(s?.title ?? "New chat", systemImage: "rectangle.on.rectangle")
          .padding(8)
          .glassEffect()
      }
      .axContainer("tile-title")
    }

    @ViewBuilder
    private var dropHighlight: some View {
      if let target {
        GeometryReader { geo in
          let r = Self.rect(for: target, in: geo.size)
          RoundedRectangle(cornerRadius: 10)
            .fill(Color.accentColor.opacity(0.18))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor, lineWidth: 2))
            .frame(width: r.width, height: r.height)
            .offset(x: r.minX, y: r.minY)
        }
        .padding(4)
      }
    }

    static func rect(for edge: Workspace.Edge, in s: CGSize) -> CGRect {
      switch edge {
      case .left: CGRect(x: 0, y: 0, width: s.width / 2, height: s.height)
      case .right: CGRect(x: s.width / 2, y: 0, width: s.width / 2, height: s.height)
      case .top: CGRect(x: 0, y: 0, width: s.width, height: s.height / 2)
      case .bottom: CGRect(x: 0, y: s.height / 2, width: s.width, height: s.height / 2)
      case .center: CGRect(origin: .zero, size: s)
      }
    }
  }

  /// Which part of a tile a point is over: the outer quarter of each side is
  /// that edge, the middle replaces.
  func dropEdge(at p: CGPoint, in s: CGSize) -> Workspace.Edge {
    guard s.width > 0, s.height > 0 else { return .center }
    let x = p.x / s.width
    let y = p.y / s.height
    let d = [(Workspace.Edge.left, x), (.right, 1 - x), (.top, y), (.bottom, 1 - y)].min { $0.1 < $1.1 }!
    return d.1 < 0.25 ? d.0 : .center
  }

  struct TileDropDelegate: DropDelegate {
    let tile: Workspace.Node
    let store: WorkspaceStore
    let size: CGSize
    @Binding var target: Workspace.Edge?

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.text]) }

    func dropUpdated(info: DropInfo) -> DropProposal? {
      target = dropEdge(at: info.location, in: size)
      return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) { target = nil }

    func performDrop(info: DropInfo) -> Bool {
      let edge = dropEdge(at: info.location, in: size)
      target = nil
      guard let provider = info.itemProviders(for: [.text]).first else { return false }
      let tileId = tile.id
      let store = store
      _ = provider.loadObject(ofClass: NSString.self) { obj, _ in
        guard let s = obj as? String, let payload = DragPayload(s) else { return }
        Task { @MainActor in
          switch payload {
          case .session(let id): store.layout.drop(id, onto: tileId, edge: edge)
          case .tile(let from): store.layout.move(from, onto: tileId, edge: edge)
          }
        }
      }
      return true
    }
  }

  /// Menu bar commands for the focused window's workspace.
  struct AppCommands: Commands {
    let model: AppModel
    @FocusedValue(\.workspace) private var workspace

    var body: some Commands {
      CommandGroup(replacing: .newItem) {
        Button("New Chat") {
          workspace?.newChat()
          model.route = .new
        }
        .keyboardShortcut("n", modifiers: .command)
        Button("Find in All Chats") {
          NotificationCenter.default.post(name: .focusSearch, object: nil)
        }
        .keyboardShortcut("f", modifiers: .command)
      }
      CommandMenu("Tiles") {
        Button("Split Right") { workspace?.splitFocused(.right) }
          .keyboardShortcut("d", modifiers: .command)
        Button("Split Down") { workspace?.splitFocused(.bottom) }
          .keyboardShortcut("d", modifiers: [.command, .shift])
        Divider()
        Button("Next Tile") { workspace?.focusNext() }
          .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
        Button("Previous Tile") { workspace?.focusPrevious() }
          .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
        Divider()
        Button("Close Tile") { workspace?.closeFocused() }
          .keyboardShortcut("w", modifiers: [.command, .control])
      }
    }
  }
#endif
