import Foundation

/// The Mac tiling workspace as a split tree: each leaf is a tile showing one
/// session (or a new chat), each inner node splits its area in two along an
/// axis at `ratio`. Pure value type: the views render it, drag and drop and
/// keyboard shortcuts call these mutations, and it is saved as JSON.
public struct Workspace: Codable, Hashable, Sendable {
  public enum Axis: String, Codable, Hashable, Sendable {
    /// Side by side (a vertical divider).
    case horizontal
    /// Stacked (a horizontal divider).
    case vertical
  }

  public enum Edge: String, Codable, Hashable, Sendable, CaseIterable {
    case left, right, top, bottom, center
  }

  public struct Node: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    /// Leaf: the session shown, nil for a new chat.
    public var sessionId: String?
    /// Split only.
    public var axis: Axis?
    /// Split only: share of the first child, 0...1.
    public var ratio: Double
    /// Empty for a leaf, two for a split.
    public var children: [Node]

    public var isLeaf: Bool { children.isEmpty }

    static func leaf(_ sessionId: String?, id: String = Workspace.newId()) -> Node {
      Node(id: id, sessionId: sessionId, axis: nil, ratio: 0.5, children: [])
    }
  }

  public var root: Node
  /// The tile keyboard input and "open chat" go to.
  public var focused: String

  public static let minRatio = 0.15

  static func newId() -> String { UUID().uuidString.lowercased() }

  public init(sessionId: String? = nil) {
    let leaf = Node.leaf(sessionId)
    root = leaf
    focused = leaf.id
  }

  // MARK: queries

  /// Tiles in reading order (left to right, top to bottom).
  public var tiles: [Node] {
    var out: [Node] = []
    func walk(_ n: Node) {
      if n.isLeaf { out.append(n) } else { n.children.forEach(walk) }
    }
    walk(root)
    return out
  }

  public func tile(_ id: String) -> Node? { tiles.first { $0.id == id } }
  public func tile(showing sessionId: String) -> Node? { tiles.first { $0.sessionId == sessionId } }
  public var focusedTile: Node? { tile(focused) }

  /// A compact description for tests and logs, e.g. `h(a,v(b,c))`.
  public var shape: String {
    func d(_ n: Node) -> String {
      if n.isLeaf { return n.sessionId ?? "new" }
      return "\(n.axis == .horizontal ? "h" : "v")(\(n.children.map(d).joined(separator: ",")))"
    }
    return d(root)
  }

  // MARK: mutations

  /// Shows `sessionId` in the focused tile, or focuses the tile already showing it.
  public mutating func open(_ sessionId: String?) {
    if let sessionId, let t = tile(showing: sessionId) {
      focused = t.id
      return
    }
    update(focused) { $0.sessionId = sessionId }
  }

  /// Drops a session onto a tile: the centre replaces what it shows, an edge
  /// splits it and puts the session on that side. A session already shown in
  /// another tile moves from there. Returns the tile now showing it.
  @discardableResult
  public mutating func drop(_ sessionId: String?, onto target: String, edge: Edge) -> String? {
    if let sessionId, let existing = tile(showing: sessionId) {
      if existing.id == target { return target }
      return move(existing.id, onto: target, edge: edge)
    }
    guard tile(target) != nil else { return nil }
    if edge == .center {
      update(target) { $0.sessionId = sessionId }
      focused = target
      return target
    }
    let leaf = Node.leaf(sessionId)
    split(target, with: leaf, edge: edge)
    focused = leaf.id
    return leaf.id
  }

  /// Moves a tile onto another tile's edge (rearranging), or swaps their contents on the centre.
  @discardableResult
  public mutating func move(_ tileId: String, onto target: String, edge: Edge) -> String? {
    guard tileId != target, let moving = tile(tileId), tile(target) != nil else { return nil }
    if edge == .center {
      let other = tile(target)?.sessionId
      update(target) { $0.sessionId = moving.sessionId }
      update(tileId) { $0.sessionId = other }
      if other == nil, tiles.count > 1 { remove(tileId) }
      focused = target
      return target
    }
    remove(tileId)
    guard tile(target) != nil else { return nil }
    split(target, with: moving, edge: edge)
    focused = moving.id
    return moving.id
  }

  /// Closes a tile; its sibling takes the space. The last tile becomes a new chat.
  public mutating func close(_ tileId: String) {
    guard tile(tileId) != nil else { return }
    if tiles.count == 1 {
      update(tileId) { $0.sessionId = nil }
      return
    }
    let order = tiles.map(\.id)
    let i = order.firstIndex(of: tileId) ?? 0
    remove(tileId)
    if focused == tileId || tile(focused) == nil {
      let left = tiles
      focused = left[min(max(0, i - 1), left.count - 1)].id
    }
  }

  /// A session went away (deleted, archived): close the tiles showing it.
  public mutating func forget(_ sessionId: String) {
    for t in tiles where t.sessionId == sessionId { close(t.id) }
  }

  public mutating func setRatio(_ splitId: String, _ ratio: Double) {
    let r = min(1 - Workspace.minRatio, max(Workspace.minRatio, ratio))
    func walk(_ n: inout Node) -> Bool {
      if n.id == splitId, !n.isLeaf {
        n.ratio = r
        return true
      }
      for i in n.children.indices where walk(&n.children[i]) { return true }
      return false
    }
    _ = walk(&root)
  }

  public mutating func focusNext() { step(1) }
  public mutating func focusPrevious() { step(-1) }

  public mutating func focus(_ tileId: String) {
    if tile(tileId) != nil { focused = tileId }
  }

  private mutating func step(_ d: Int) {
    let order = tiles.map(\.id)
    guard let i = order.firstIndex(of: focused), !order.isEmpty else {
      focused = order.first ?? focused
      return
    }
    focused = order[(i + d + order.count) % order.count]
  }

  /// Drops tiles whose sessions no longer exist (after a restart, from another device).
  public mutating func prune(keeping known: Set<String>) {
    for t in tiles where t.sessionId.map({ !known.contains($0) }) ?? false { close(t.id) }
  }

  // MARK: tree surgery

  private mutating func update(_ tileId: String, _ f: (inout Node) -> Void) {
    func walk(_ n: inout Node) -> Bool {
      if n.id == tileId, n.isLeaf {
        f(&n)
        return true
      }
      for i in n.children.indices where walk(&n.children[i]) { return true }
      return false
    }
    _ = walk(&root)
  }

  private mutating func split(_ target: String, with leaf: Node, edge: Edge) {
    func walk(_ n: inout Node) -> Bool {
      if n.id == target, n.isLeaf {
        let old = n
        let axis: Axis = (edge == .left || edge == .right) ? .horizontal : .vertical
        let first = (edge == .left || edge == .top)
        n = Node(id: Workspace.newId(), sessionId: nil, axis: axis, ratio: 0.5, children: first ? [leaf, old] : [old, leaf])
        return true
      }
      for i in n.children.indices where walk(&n.children[i]) { return true }
      return false
    }
    _ = walk(&root)
  }

  private mutating func remove(_ tileId: String) {
    if root.id == tileId { return }
    func walk(_ n: inout Node) -> Bool {
      if let i = n.children.firstIndex(where: { $0.id == tileId && $0.isLeaf }) {
        n = n.children[1 - i]
        return true
      }
      for i in n.children.indices where walk(&n.children[i]) { return true }
      return false
    }
    _ = walk(&root)
  }
}
