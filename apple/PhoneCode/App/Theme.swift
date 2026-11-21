import SwiftUI

#if os(iOS)
  import UIKit
  typealias PlatformColor = UIColor
#else
  import AppKit
  typealias PlatformColor = NSColor
#endif

/// The web app's design tokens (packages/web/src/styles/tokens.css), so the
/// native apps look like the same product. Mint is the accent and is used
/// sparingly (send, unread, focus, the caret); surfaces are neutral.
enum Theme {
  // Surfaces
  static let bubble = Color(light: 0xECEEF2, dark: 0x2A2B2F)
  static let card = Color(light: 0xF7F7F9, dark: 0x141416)
  static let hairline = Color(light: .init(white: 0, alpha: 0.07), dark: .init(white: 1, alpha: 0.08))
  static let codeBackground = Color(light: 0xF6F7F9, dark: 0x0F1012)
  static let inlineCode = Color(light: .init(white: 0, alpha: 0.06), dark: .init(white: 1, alpha: 0.09))
  /// Selected sidebar row and focused tile bar: a neutral fill, not the accent.
  static let selection = Color(
    light: .init(red: 120 / 255, green: 120 / 255, blue: 128 / 255, alpha: 0.16),
    dark: .init(red: 120 / 255, green: 120 / 255, blue: 128 / 255, alpha: 0.26))

  /// Text on the accent (the send button).
  static let onAccent = Color(light: 0xFFFFFF, dark: 0x00281B)

  // Status
  static let attention = Color(light: 0xE07800, dark: 0xFFA733)
  static let danger = Color(light: 0xE5352B, dark: 0xFF5A4F)
  static let diffAdd = Color(light: .init(red: 34 / 255, green: 170 / 255, blue: 90 / 255, alpha: 0.12), dark: .init(red: 46 / 255, green: 204 / 255, blue: 113 / 255, alpha: 0.16))
  static let diffAddText = Color(light: 0x0C7A3E, dark: 0x7EE2A8)
  static let diffDel = Color(light: .init(red: 229 / 255, green: 53 / 255, blue: 43 / 255, alpha: 0.10), dark: .init(red: 1, green: 90 / 255, blue: 79 / 255, alpha: 0.16))
  static let diffDelText = Color(light: 0xB4231B, dark: 0xFF9C94)
  static let diffHunk = Color(light: .init(red: 10 / 255, green: 108 / 255, blue: 1, alpha: 0.08), dark: .init(red: 100 / 255, green: 168 / 255, blue: 1, alpha: 0.12))

  // Code highlighting
  static let codeKeyword = Color(light: 0x9A3FC7, dark: 0xD58CFF)
  static let codeString = Color(light: 0x13854E, dark: 0x84F0B8)
  static let codeNumber = Color(light: 0x946200, dark: 0xFFD166)
  static let codeComment = Color(light: 0x8A8F98, dark: 0x6B717C)

  /// Agent glyph gradients (top-leading to bottom-trailing).
  static func agentGradient(_ id: String) -> [Color] {
    switch id {
    case "claude": [Color(hex: 0xF0956B), Color(hex: 0xD3613F)]
    case "codex": [Color(hex: 0x8B93FF), Color(hex: 0x4F55E6)]
    case "gemini": [Color(hex: 0x6FA8FF), Color(hex: 0x7A4FE0)]
    case "terminal": [Color(hex: 0x3B3F47), Color(hex: 0x1B1D21)]
    default: [Color(hex: 0x4FD1B5), Color(hex: 0x1E9C8A)]
    }
  }

  static let terminalMark = Color(hex: 0x59F0BB)
}

/// The terminal palette, the same as the web app's xterm themes.
struct TerminalPalette {
  let background: PlatformColor
  let foreground: PlatformColor
  let caret: PlatformColor
  let selection: PlatformColor
  /// The 16 ANSI colors as 0xRRGGBB.
  let ansi: [UInt32]

  static let dark = TerminalPalette(
    background: .hex(0x0A0B0D), foreground: .hex(0xE7E9EE), caret: .hex(0x3BE0A8),
    selection: .hex(0x3BE0A8, alpha: 0.3),
    ansi: [
      0x2A2D33, 0xFF6B6B, 0x5FE3A1, 0xFFD166, 0x6AA9FF, 0xD58CFF, 0x4FD6E0, 0xD5D8DE,
      0x5C616B, 0xFF8787, 0x84F0B8, 0xFFE08A, 0x93C2FF, 0xE5ADFF, 0x7DE8EF, 0xFFFFFF,
    ])

  static let light = TerminalPalette(
    background: .hex(0xFBFBFC), foreground: .hex(0x1D1F24), caret: .hex(0x00A676),
    selection: .hex(0x00A676, alpha: 0.22),
    ansi: [
      0x1D1F24, 0xC8302B, 0x13854E, 0x946200, 0x1F5FD1, 0x9A3FC7, 0x0B7F8A, 0x6B7079,
      0x8A8F98, 0xE0443E, 0x1A9C5D, 0xA87200, 0x2F74EA, 0xB356DF, 0x12929E, 0x1D1F24,
    ])

  static func forScheme(_ s: ColorScheme) -> TerminalPalette { s == .dark ? .dark : .light }
}

extension PlatformColor {
  static func hex(_ v: UInt32, alpha: CGFloat = 1) -> PlatformColor {
    PlatformColor(
      red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255,
      alpha: alpha)
  }
}

extension Color {
  init(hex: UInt32) { self.init(PlatformColor.hex(hex)) }

  init(light: UInt32, dark: UInt32) { self.init(light: .hex(light), dark: .hex(dark)) }

  /// A color that follows the light/dark appearance.
  init(light: PlatformColor, dark: PlatformColor) {
    #if os(iOS)
      self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    #else
      self.init(
        nsColor: NSColor(name: nil) { a in
          a.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    #endif
  }
}
