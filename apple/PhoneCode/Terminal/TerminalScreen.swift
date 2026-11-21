import PhoneCodeCore
import SwiftTerm
import SwiftUI

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// A terminal session: SwiftTerm's emulator fed by `term.snapshot` /
/// `term.data`; keystrokes go out as `term.input`, size changes as `term.resize`.
struct TerminalScreen: View {
  @Environment(AppModel.self) private var model
  let session: SessionInfo
  var embedded = false
  @State private var bridge = TerminalBridge()

  var body: some View {
    VStack(spacing: 0) {
      ConnectionBanner()
      TerminalHost(bridge: bridge, fontSize: model.termFontSize)
        .background(Color.black)
        .accessibilityIdentifier("terminal-view")
      #if os(iOS)
        KeyBar { bridge.send($0) }
      #endif
      if let code = bridge.exitCode {
        Text("Process exited\(code.map { " with code \($0)" } ?? "")")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .padding(6)
      }
    }
    .onAppear {
      bridge.attach(client: model.client, sessionId: session.id)
      model.visibleSessions.insert(session.id)
    }
    .onDisappear {
      bridge.detach()
      model.visibleSessions.remove(session.id)
    }
    #if os(iOS)
      .navigationTitle(session.title)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .axContainer("screen-terminal")
  }
}

/// Connects one SwiftTerm view to the client.
@MainActor @Observable
final class TerminalBridge: TerminalSink {
  @ObservationIgnored weak var view: TerminalView?
  @ObservationIgnored private weak var client: PhoneCodeClient?
  @ObservationIgnored private var sessionId: String?
  @ObservationIgnored private var lastSize: (Int, Int)?
  var exitCode: Int?? = nil

  func attach(client: PhoneCodeClient, sessionId: String) {
    self.client = client
    self.sessionId = sessionId
    client.attachTerminal(sessionId, self)
  }

  func detach() {
    if let client, let sessionId { client.detachTerminal(sessionId, self) }
  }

  func send(_ s: String) {
    guard let client, let sessionId else { return }
    client.terminalInput(sessionId, s)
  }

  func resized(cols: Int, rows: Int) {
    guard cols > 0, rows > 0, let client, let sessionId else { return }
    if let l = lastSize, l == (cols, rows) { return }
    lastSize = (cols, rows)
    client.terminalResize(sessionId, cols: cols, rows: rows)
  }

  // TerminalSink
  func terminalSnapshot(data: String, cols: Int, rows: Int) {
    // Full reset (RIS), then the screen and scrollback as the daemon has them.
    view?.feed(text: "\u{1b}c" + data)
    exitCode = nil
  }

  func terminalData(_ data: String) { view?.feed(text: data) }

  func terminalExit(code: Int?) {
    exitCode = .some(code)
    view?.feed(text: "\r\n\u{1b}[2m[process exited\(code.map { " with code \($0)" } ?? "")]\u{1b}[0m\r\n")
  }
}

final class TerminalDelegateProxy: NSObject, TerminalViewDelegate {
  let bridge: TerminalBridge
  init(bridge: TerminalBridge) { self.bridge = bridge }

  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { bridge.resized(cols: newCols, rows: newRows) }
  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func send(source: TerminalView, data: ArraySlice<UInt8>) { bridge.send(String(decoding: data, as: UTF8.self)) }
  func scrolled(source: TerminalView, position: Double) {}
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

#if os(iOS)
  struct TerminalHost: UIViewRepresentable {
    let bridge: TerminalBridge
    let fontSize: Double

    func makeCoordinator() -> TerminalDelegateProxy { TerminalDelegateProxy(bridge: bridge) }

    func makeUIView(context: Context) -> TerminalView {
      let v = TerminalView(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
      v.terminalDelegate = context.coordinator
      v.nativeBackgroundColor = .black
      v.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
      bridge.view = v
      DispatchQueue.main.async { _ = v.becomeFirstResponder() }
      return v
    }

    func updateUIView(_ v: TerminalView, context: Context) {
      if v.font.pointSize != fontSize { v.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular) }
    }
  }

  /// Keys a phone keyboard lacks (SwiftTerm adds its own esc/ctrl/arrow row above the keyboard).
  struct KeyBar: View {
    var send: (String) -> Void
    private let keys: [(String, String)] = [
      ("esc", "\u{1b}"), ("tab", "\t"), ("^C", "\u{03}"), ("^D", "\u{04}"), ("^Z", "\u{1a}"), ("^L", "\u{0c}"),
      ("^R", "\u{12}"), ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B"), ("←", "\u{1b}[D"), ("→", "\u{1b}[C"), ("home", "\u{1b}[H"),
      ("end", "\u{1b}[F"), ("pgup", "\u{1b}[5~"), ("pgdn", "\u{1b}[6~"),
    ]

    var body: some View {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(keys, id: \.0) { k in
            Button(k.0) {
              send(k.1)
              Haptics.play(.select)
            }
            .font(.callout.monospaced())
            .buttonStyle(.glass)
            .controlSize(.small)
            .accessibilityIdentifier("key-\(k.0)")
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
      }
      .axContainer("key-bar")
    }
  }
#else
  struct TerminalHost: NSViewRepresentable {
    let bridge: TerminalBridge
    let fontSize: Double

    func makeCoordinator() -> TerminalDelegateProxy { TerminalDelegateProxy(bridge: bridge) }

    func makeNSView(context: Context) -> TerminalView {
      let v = TerminalView(frame: .zero, font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
      v.terminalDelegate = context.coordinator
      v.nativeBackgroundColor = .black
      v.nativeForegroundColor = NSColor(white: 0.92, alpha: 1)
      bridge.view = v
      DispatchQueue.main.async { v.window?.makeFirstResponder(v) }
      return v
    }

    func updateNSView(_ v: TerminalView, context: Context) {
      if v.font.pointSize != fontSize { v.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular) }
    }
  }
#endif
