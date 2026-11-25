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
    @State private var pairingPhone = false

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
              if model.hub.isLocal(model.creds) {
                Button("Pair a phone", systemImage: "qrcode") { pairingPhone = true }
                  .help("Show the QR code your phone scans")
                  .accessibilityIdentifier("pair-phone")
              }
              SettingsLink {
                Label("This computer", systemImage: "desktopcomputer")
              }
              .accessibilityIdentifier("open-computer")
            }
          }
      }
      .overlay { WorkspaceDragCard() }
      .onAppear { WorkspaceDrag.shared.installMonitor() }
      .focusedSceneValue(\.workspace, store)
      .sheet(isPresented: $pairingPhone) { PairPhoneView() }
      .onAppear {
        guard !loaded else { return }
        loaded = true
        store.layout = model.didReset ? Workspace() : WorkspaceStore.restore(saved)
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
    /// The edge a dragged chat or tile would land on here, if it is over this tile.
    private var target: Workspace.Edge? {
      let d = WorkspaceDrag.shared
      return d.target?.tile == tile.id ? d.target?.edge : nil
    }

    @State private var hovering = false

    private var focused: Bool { store.layout.focused == tile.id }
    private var route: Route { tile.sessionId.map { .session($0) } ?? .new }
    /// The controls show on the tile being worked in and on the one under the
    /// pointer; otherwise the chats read edge to edge, with no chrome.
    private var showControls: Bool { store.layout.tiles.count > 1 && (focused || hovering) }

    var body: some View {
      ChatScreen(route: route, embedded: true)
        .id(route)
        .background(Color.appBackground)
        .overlay(alignment: .topTrailing) {
          if store.layout.tiles.count > 1 {
            tileControls
              .padding(8)
              .opacity(showControls ? 1 : 0)
              .allowsHitTesting(showControls)
              .animation(.easeOut(duration: 0.15), value: showControls)
          }
        }
        .onHover { hovering = $0 }
        .overlay { dropHighlight.allowsHitTesting(false) }
      // Where this tile is on screen, so a drag knows which tile and edge it is over.
      .background(ScreenFrameReader { frame in WorkspaceDrag.shared.register(tile: tile.id, frame: frame, store: store) })
      .onDisappear { WorkspaceDrag.shared.unregister(tile: tile.id) }
      .simultaneousGesture(TapGesture().onEnded { store.layout.focus(tile.id) })
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tile")
    }

    /// A small floating pill: the chat's title (grab it to move the tile), more, close.
    private var tileControls: some View {
      let s = tile.sessionId.flatMap { model.client.session($0) }
      return HStack(spacing: 2) {
        HStack(spacing: 6) {
          if let s { StatusDot(status: s.status) }
          Text(s?.title ?? "New chat")
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .frame(maxWidth: 200, alignment: .leading)
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .frame(height: 26)
        .contentShape(.rect)
        .workspaceDraggable(.tile(tile.id), title: s?.title ?? "New chat")
        .help("Drag to move this tile")
        Menu {
          Button("Split right", systemImage: "rectangle.split.2x1") { store.layout.drop(nil, onto: tile.id, edge: .right) }
          Button("Split down", systemImage: "rectangle.split.1x2") { store.layout.drop(nil, onto: tile.id, edge: .bottom) }
          if let s {
            Divider()
            Button("Archive", systemImage: "archivebox") { model.archive(s) }
          }
        } label: {
          Image(systemName: "ellipsis")
            .frame(width: 22, height: 26)
            .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        Button {
          store.layout.close(tile.id)
        } label: {
          Image(systemName: "xmark")
            .font(.caption2.weight(.bold))
            .frame(width: 22, height: 26)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Close tile (⌃⌘W)")
        .accessibilityIdentifier("tile-close")
        .padding(.trailing, 4)
      }
      .foregroundStyle(.secondary)
      .background(.regularMaterial, in: .capsule)
      .overlay(Capsule().strokeBorder(Theme.hairline))
      .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
      .axContainer("tile-title")
    }

    @ViewBuilder
    /// Where a dragged chat or tile will land: an outline of the half it
    /// will take (or the whole tile it replaces), with what will happen.
    private var dropHighlight: some View {
      GeometryReader { geo in
        if let target {
          let r = Self.rect(for: target, in: geo.size).insetBy(dx: 6, dy: 6)
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(Theme.ink.opacity(0.06))
            .overlay(
              RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.ink.opacity(0.7), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
            )
            .overlay {
              Label(Self.title(for: target), systemImage: Self.symbol(for: target))
                .font(.callout.weight(.semibold))
                .foregroundStyle(Theme.onInk)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Theme.ink, in: .capsule)
            }
            .frame(width: r.width, height: r.height)
            .offset(x: r.minX, y: r.minY)
        }
      }
      .accessibilityIdentifier(target == nil ? "" : "drop-target")
    }

    static func title(for edge: Workspace.Edge) -> String {
      switch edge {
      case .left: "Split left"
      case .right: "Split right"
      case .top: "Split up"
      case .bottom: "Split down"
      case .center: "Replace"
      }
    }

    static func symbol(for edge: Workspace.Edge) -> String {
      switch edge {
      case .left: "rectangle.lefthalf.inset.filled"
      case .right: "rectangle.righthalf.inset.filled"
      case .top: "rectangle.tophalf.inset.filled"
      case .bottom: "rectangle.bottomhalf.inset.filled"
      case .center: "rectangle.inset.filled"
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

  /// Dragging a chat (from the sidebar) or a tile (by its title bar) onto the
  /// workspace. An in-app drag: the app tracks the pointer and every tile's
  /// frame, so it knows which tile and edge the pointer is over, outlines it,
  /// and drops there on release. (AppKit drag and drop lost drops over the
  /// chats' scroll views and gives no position to outline.)
  @MainActor @Observable
  final class WorkspaceDrag {
    static let shared = WorkspaceDrag()

    struct Target: Equatable {
      var tile: String
      var edge: Workspace.Edge
    }

    private(set) var payload: DragPayload?
    private(set) var title = ""
    /// The pointer, in screen coordinates (origin bottom left), while dragging.
    private(set) var location: CGPoint?
    private(set) var target: Target?
    @ObservationIgnored private var tiles: [String: (frame: CGRect, store: WorkspaceStore)] = [:]
    /// What can be dragged (sidebar rows, tile title bars), by payload string.
    @ObservationIgnored private var sources: [String: (frame: CGRect, payload: DragPayload, title: String)] = [:]
    @ObservationIgnored private var pressed: (payload: DragPayload, title: String, at: CGPoint)?
    @ObservationIgnored private var monitor: Any?

    var active: Bool { payload != nil }

    func register(tile: String, frame: CGRect, store: WorkspaceStore) { tiles[tile] = (frame, store) }
    func unregister(tile: String) { tiles[tile] = nil }

    func register(source payload: DragPayload, title: String, frame: CGRect) {
      sources[payload.string] = (frame, payload, title)
    }

    func unregister(source payload: DragPayload) { sources[payload.string] = nil }

    /// Watches the mouse for the whole app. A SwiftUI List row on macOS is an
    /// AppKit table row that keeps the drag to itself, so gestures there never
    /// fire; the events still pass through here first, and on to the list.
    func installMonitor() {
      guard monitor == nil else { return }
      monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { e in
        MainActor.assumeIsolated { WorkspaceDrag.shared.handle(e) }
        return e
      }
    }

    private func handle(_ e: NSEvent) {
      let p = NSEvent.mouseLocation
      switch e.type {
      case .leftMouseDown:
        pressed = sources.values.first { $0.frame.contains(p) }.map { ($0.payload, $0.title, p) }
      case .leftMouseDragged:
        guard let pressed else { return }
        if active || hypot(p.x - pressed.at.x, p.y - pressed.at.y) > 6 { move(pressed.payload, title: pressed.title) }
      case .leftMouseUp:
        pressed = nil
        if active { finish() }
      default:
        break
      }
    }

    /// Screen coordinates throughout: the sidebar and the workspace are separate
    /// hosting views, so SwiftUI's "global" coordinates differ between them.
    func move(_ payload: DragPayload, title: String) {
      let point = NSEvent.mouseLocation
      self.payload = payload
      self.title = title
      location = point
      let hit = tiles.first { $0.value.frame.contains(point) }
      let next = hit.map { id, t in
        // dropEdge measures from the top left; screen y grows upward.
        Target(tile: id, edge: dropEdge(at: CGPoint(x: point.x - t.frame.minX, y: t.frame.maxY - point.y), in: t.frame.size))
      }
      // A tile dropped on itself goes nowhere.
      if case .tile(let from) = payload, next?.tile == from { target = nil } else if next != target { target = next }
    }

    func finish() {
      defer {
        payload = nil
        location = nil
        target = nil
      }
      guard let payload, let target, let store = tiles[target.tile]?.store else { return }
      withAnimation(.snappy(duration: 0.25)) {
        switch payload {
        case .session(let id): store.layout.drop(id, onto: target.tile, edge: target.edge)
        case .tile(let from): store.layout.move(from, onto: target.tile, edge: target.edge)
        }
      }
    }
  }

  extension View {
    /// Drag this onto a tile of the workspace (a chat from the sidebar, or a tile by its title bar).
    func workspaceDraggable(_ payload: DragPayload, title: String) -> some View {
      background(
        ScreenFrameReader { frame in WorkspaceDrag.shared.register(source: payload, title: title, frame: frame) }
      )
      .onDisappear { WorkspaceDrag.shared.unregister(source: payload) }
    }
  }

  /// The card under the pointer while dragging, over the whole window.
  struct WorkspaceDragCard: View {
    @State private var frame: CGRect = .zero

    var body: some View {
      let drag = WorkspaceDrag.shared
      ZStack(alignment: .topLeading) {
        Color.clear
        if let p = drag.location, frame.contains(p) {
          DragCard(title: drag.title)
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            .fixedSize()
            .offset(x: p.x - frame.minX + 14, y: frame.maxY - p.y + 10)
            .accessibilityIdentifier("drag-card")
        }
      }
      .background(ScreenFrameReader { frame = $0 })
      .allowsHitTesting(false)
    }
  }

  /// Reports a view's frame in screen coordinates whenever it moves or resizes
  /// (with its window too).
  struct ScreenFrameReader: NSViewRepresentable {
    var report: (CGRect) -> Void

    func makeNSView(context: Context) -> Reader {
      let v = Reader()
      v.report = report
      return v
    }

    func updateNSView(_ v: Reader, context: Context) {
      v.report = report
      v.send()
    }

    final class Reader: NSView {
      var report: ((CGRect) -> Void)?
      private var observers: [NSObjectProtocol] = []

      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let window else { return }
        for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
          observers.append(
            NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
              MainActor.assumeIsolated { self?.send() }
            })
        }
        send()
      }

      override func layout() {
        super.layout()
        send()
      }

      override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        send()
      }

      func send() {
        guard let window else { return }
        let frame = window.convertToScreen(convert(bounds, to: nil))
        DispatchQueue.main.async { [report] in report?(frame) }
      }

      override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
  }

  /// Menu bar commands for the focused window's workspace.
  struct AppCommands: Commands {
    let model: AppModel
    @FocusedValue(\.workspace) private var workspace

    var body: some Commands {
      CommandGroup(after: .appInfo) {
        Button("Check for Updates…") {
          Task { await Updater.shared.check(userAsked: true) }
        }
      }
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
