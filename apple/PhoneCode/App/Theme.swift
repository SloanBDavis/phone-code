import SwiftUI

#if os(iOS)
  import UIKit
  typealias PlatformColor = UIColor
#else
  import AppKit
  typealias PlatformColor = NSColor
#endif

/// Graphite: phone-code's native design language. Monochrome — near-black
/// and white with zinc grays, no brand hue. The primary action is a solid
/// near-black pill (white in dark mode); everything else is a quiet gray pill
/// whose radius follows its container's (concentric corners). Color appears
/// only where it means something: attention, errors, diffs, code.
enum Theme {
  // Ink and surfaces (zinc)
  /// Primary actions and emphasis: near-black in light, near-white in dark.
  static let ink = Color(light: 0x18181B, dark: 0xF4F4F5)
  /// Text and icons on `ink`.
  static let onInk = Color(light: 0xFFFFFF, dark: 0x18181B)
  /// Quiet controls: chips, the photo button, the idle send button.
  static let chip = Color(light: .init(white: 0, alpha: 0.05), dark: .init(white: 1, alpha: 0.08))
  static let chipPressed = Color(light: .init(white: 0, alpha: 0.10), dark: .init(white: 1, alpha: 0.14))
  static let bubble = Color(light: 0xF4F4F5, dark: 0x27272A)
  static let card = Color(light: 0xFAFAFA, dark: 0x141416)
  static let hairline = Color(light: .init(white: 0, alpha: 0.08), dark: .init(white: 1, alpha: 0.09))
  static let codeBackground = Color(light: 0xFAFAFA, dark: 0x0F0F11)
  static let inlineCode = Color(light: .init(white: 0, alpha: 0.06), dark: .init(white: 1, alpha: 0.09))
  /// Selected sidebar row and focused tile bar.
  static let selection = Color(light: .init(white: 0, alpha: 0.06), dark: .init(white: 1, alpha: 0.09))

  // Status: the only hues, and only where they mean something.
  static let attention = Color(light: 0xC2410C, dark: 0xFB923C)
  static let danger = Color(light: 0xDC2626, dark: 0xF87171)
  static let diffAdd = Color(light: .init(red: 22 / 255, green: 163 / 255, blue: 74 / 255, alpha: 0.10), dark: .init(red: 74 / 255, green: 222 / 255, blue: 128 / 255, alpha: 0.13))
  static let diffAddText = Color(light: 0x15803D, dark: 0x86EFAC)
  static let diffDel = Color(light: .init(red: 220 / 255, green: 38 / 255, blue: 38 / 255, alpha: 0.09), dark: .init(red: 248 / 255, green: 113 / 255, blue: 113 / 255, alpha: 0.13))
  static let diffDelText = Color(light: 0xB91C1C, dark: 0xFCA5A5)
  static let diffHunk = Color(light: .init(white: 0, alpha: 0.04), dark: .init(white: 1, alpha: 0.06))

  // Code highlighting: muted, so code reads as text, not confetti.
  static let codeKeyword = Color(light: 0x7C3AED, dark: 0xC4B5FD)
  static let codeString = Color(light: 0x15803D, dark: 0x86EFAC)
  static let codeNumber = Color(light: 0xB45309, dark: 0xFCD34D)
  static let codeComment = Color(light: 0x71717A, dark: 0x71717A)
  static let codeType = Color(light: 0x0369A1, dark: 0x7DD3FC)

  /// Concentric corners: a control inset by `padding` inside a container with
  /// `outer` radius gets `outer - padding`.
  static func inner(_ outer: CGFloat, padding: CGFloat) -> CGFloat { max(outer - padding, 4) }
}

/// The quiet pill: chips, secondary actions. Capsule, gray fill, no border.
struct GraphiteButtonStyle: ButtonStyle {
  @Environment(\.controlSize) private var size
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(size == .small || size == .mini ? .footnote.weight(.medium) : .callout.weight(.medium))
      .labelStyle(GraphiteLabelStyle())
      .foregroundStyle(configuration.role == .destructive ? Theme.danger : Color.primary)
      .padding(.horizontal, size == .small || size == .mini ? 11 : 14)
      .frame(minHeight: size == .small || size == .mini ? 28 : 34)
      .background(configuration.isPressed ? Theme.chipPressed : Theme.chip, in: .capsule)
      .contentShape(.capsule)
      .opacity(enabled ? 1 : 0.45)
  }
}

/// The primary pill: one per view. Ink fill, white text (inverted in dark mode).
struct GraphitePrimaryButtonStyle: ButtonStyle {
  @Environment(\.controlSize) private var size
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    let destructive = configuration.role == .destructive
    configuration.label
      .font(size == .small || size == .mini ? .footnote.weight(.semibold) : .callout.weight(.semibold))
      .labelStyle(GraphiteLabelStyle())
      .foregroundStyle(destructive ? Color.white : Theme.onInk)
      .padding(.horizontal, size == .small || size == .mini ? 12 : 16)
      .frame(minHeight: size == .small || size == .mini ? 28 : 34)
      .background(destructive ? Theme.danger : Theme.ink, in: .capsule)
      .opacity(configuration.isPressed ? 0.82 : enabled ? 1 : 0.35)
      .contentShape(.capsule)
  }
}

extension View {
  /// The quiet pill look for a menu's label. Menus keep the system's plain
  /// button style (so macOS draws a native, accessible menu) and wear the
  /// chip on their label instead.
  func graphiteChip() -> some View {
    labelStyle(GraphiteLabelStyle())
      .font(.footnote.weight(.medium))
      .foregroundStyle(Color.primary)
      .padding(.horizontal, 11)
      .frame(minHeight: 28)
      .background(Theme.chip, in: .capsule)
      .contentShape(.capsule)
  }
}

/// Icon and title close together, the icon a touch quieter.
struct GraphiteLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) {
      configuration.icon.imageScale(.small).foregroundStyle(.secondary)
      configuration.title
    }
  }
}

extension ButtonStyle where Self == GraphiteButtonStyle {
  static var graphite: GraphiteButtonStyle { GraphiteButtonStyle() }
}

extension ButtonStyle where Self == GraphitePrimaryButtonStyle {
  static var graphitePrimary: GraphitePrimaryButtonStyle { GraphitePrimaryButtonStyle() }
}

/// The terminal palette: Graphite surfaces and caret, the web app's ANSI colors.
struct TerminalPalette {
  let background: PlatformColor
  let foreground: PlatformColor
  let caret: PlatformColor
  let selection: PlatformColor
  /// The 16 ANSI colors as 0xRRGGBB.
  let ansi: [UInt32]

  static let dark = TerminalPalette(
    background: .hex(0x0C0C0E), foreground: .hex(0xE4E4E7), caret: .hex(0xF4F4F5),
    selection: .hex(0xFFFFFF, alpha: 0.2),
    ansi: [
      0x2A2D33, 0xFF6B6B, 0x5FE3A1, 0xFFD166, 0x6AA9FF, 0xD58CFF, 0x4FD6E0, 0xD5D8DE,
      0x5C616B, 0xFF8787, 0x84F0B8, 0xFFE08A, 0x93C2FF, 0xE5ADFF, 0x7DE8EF, 0xFFFFFF,
    ])

  static let light = TerminalPalette(
    background: .hex(0xFAFAFA), foreground: .hex(0x18181B), caret: .hex(0x18181B),
    selection: .hex(0x000000, alpha: 0.12),
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
