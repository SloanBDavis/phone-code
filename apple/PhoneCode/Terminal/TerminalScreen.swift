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
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    VStack(spacing: 0) {
      ConnectionBanner()
      TerminalHost(bridge: bridge, fontSize: model.termFontSize, palette: .forScheme(scheme))
        // Breathing room around the grid, in the terminal's own color.
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(TerminalPalette.forScheme(scheme).background))
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

extension TerminalView {
  /// The web app's terminal look: its palette, a blinking bar caret.
  @MainActor func apply(_ p: TerminalPalette) {
    installColors(p.ansi.map { v in
      SwiftTerm.Color(red8: UInt16((v >> 16) & 0xFF), green8: UInt16((v >> 8) & 0xFF), blue8: UInt16(v & 0xFF))
    })
    nativeBackgroundColor = p.background
    nativeForegroundColor = p.foreground
    caretColor = p.caret
    selectedTextBackgroundColor = p.selection
  }
}

final class TerminalDelegateProxy: NSObject, TerminalViewDelegate {
  let bridge: TerminalBridge
  /// The palette's background last applied (palettes are static, so identity tells them apart).
  var appliedBackground: PlatformColor?
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
    let palette: TerminalPalette

    func makeCoordinator() -> TerminalDelegateProxy { TerminalDelegateProxy(bridge: bridge) }

    func makeUIView(context: Context) -> TerminalView {
      let v = TerminalView(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
      v.terminalDelegate = context.coordinator
      v.apply(palette)
      context.coordinator.appliedBackground = palette.background
      // Steady: a caret that blinks forever keeps the app from ever being
      // idle (battery, and UI tests wait on it).
      v.setCursorStyle(.steadyBar)
      v.accessibilityIdentifier = "terminal-view"
      bridge.view = v
      DispatchQueue.main.async { _ = v.becomeFirstResponder() }
      return v
    }

    func updateUIView(_ v: TerminalView, context: Context) {
      if v.font.pointSize != fontSize { v.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular) }
      if context.coordinator.appliedBackground !== palette.background {
        v.apply(palette)
        context.coordinator.appliedBackground = palette.background
      }
    }
  }

#else
  struct TerminalHost: NSViewRepresentable {
    let bridge: TerminalBridge
    let fontSize: Double
    let palette: TerminalPalette

    func makeCoordinator() -> TerminalDelegateProxy { TerminalDelegateProxy(bridge: bridge) }

    func makeNSView(context: Context) -> TerminalView {
      let v = TerminalView(frame: .zero, font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
      v.terminalDelegate = context.coordinator
      v.apply(palette)
      context.coordinator.appliedBackground = palette.background
      v.setCursorStyle(.blinkBar)
      // SwiftTerm's AppKit view is not an accessibility element at all:
      // expose it as a text area so VoiceOver (and UI tests) can find it.
      v.setAccessibilityElement(true)
      v.setAccessibilityRole(.textArea)
      v.setAccessibilityLabel("Terminal")
      v.setAccessibilityIdentifier("terminal-view")
      bridge.view = v
      DispatchQueue.main.async { v.window?.makeFirstResponder(v) }
      return v
    }

    func updateNSView(_ v: TerminalView, context: Context) {
      if v.font.pointSize != fontSize { v.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular) }
      if context.coordinator.appliedBackground !== palette.background {
        v.apply(palette)
        context.coordinator.appliedBackground = palette.background
      }
    }
  }
#endif
