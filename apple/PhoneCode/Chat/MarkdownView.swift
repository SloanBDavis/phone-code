import PhoneCodeCore
import SwiftUI

/// Native markdown: blocks from PhoneCodeCore's parser, inline styles from
/// `AttributedString(markdown:)`, code blocks highlighted by Core's lexer.
struct MarkdownView: View {
  let text: String

  var body: some View {
    let blocks = Markdown.blocks(text)
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
        block(b)
      }
    }
    .textSelection(.enabled)
  }

  @ViewBuilder
  private func block(_ b: MarkdownBlock) -> some View {
    switch b {
    case .heading(let level, let t):
      Text(Self.inline(t))
        .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
        .padding(.top, 4)
    case .paragraph(let t):
      Text(Self.inline(t))
        .fixedSize(horizontal: false, vertical: true)
    case .code(let lang, let code):
      CodeBlock(code: code, language: lang)
    case .list(let ordered, let items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let c = item.checked {
              Image(systemName: c ? "checkmark.square.fill" : "square").foregroundStyle(.secondary)
            } else {
              Text(ordered ? "\(item.number ?? i + 1)." : "•")
                .foregroundStyle(.secondary)
                .monospacedDigit()
            }
            Text(Self.inline(item.text))
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.leading, CGFloat(item.depth) * 16)
        }
      }
    case .quote(let t):
      HStack(spacing: 10) {
        RoundedRectangle(cornerRadius: 2).fill(.tertiary).frame(width: 3)
        Text(Self.inline(t)).foregroundStyle(.secondary)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .table(let header, let aligns, let rows):
      MarkdownTable(header: header, aligns: aligns, rows: rows)
    case .rule:
      Divider()
    }
  }

  static func inline(_ s: String) -> AttributedString {
    let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    guard var a = try? AttributedString(markdown: s, options: opts) else { return AttributedString(s) }
    // Code spans: monospaced on a tinted background.
    for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
      a[run.range].font = Font.body.monospaced()
      a[run.range].backgroundColor = Theme.inlineCode
    }
    return a
  }
}

/// A table as a table: a header band, a line under every row and between the
/// columns, as wide as the chat. One too wide for it scrolls sideways.
struct MarkdownTable: View {
  let header: [String]
  let aligns: [MarkdownAlignment]
  let rows: [[String]]

  var body: some View {
    ViewThatFits(in: .horizontal) {
      grid(fill: true)
      ScrollView(.horizontal, showsIndicators: false) { grid(fill: false) }
    }
    .background(Theme.codeBackground, in: .rect(cornerRadius: 10))
    .clipShape(.rect(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.hairline))
    .axContainer("markdown-table")
  }

  private func grid(fill: Bool) -> some View {
    Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
      GridRow {
        ForEach(0..<header.count, id: \.self) { i in
          cell(header[i], column: i, fill: fill)
            .fontWeight(.semibold)
            .background(Theme.chip)
        }
      }
      ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
        Rectangle().fill(Theme.hairline).frame(height: 1).gridCellUnsizedAxes(.horizontal)
        GridRow {
          // Every row has the header's columns: a short one is padded, a long one cut.
          ForEach(0..<header.count, id: \.self) { i in
            cell(i < r.count ? r[i] : "", column: i, fill: fill)
          }
        }
      }
    }
  }

  private func cell(_ text: String, column i: Int, fill: Bool) -> some View {
    Text(MarkdownView.inline(text))
      .multilineTextAlignment(textAlignment(i))
      .fixedSize(horizontal: !fill, vertical: true)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .frame(maxWidth: fill ? .infinity : nil, maxHeight: .infinity, alignment: Alignment(horizontal: alignment(i), vertical: .top))
      .overlay(alignment: .leading) {
        if i > 0 { Rectangle().fill(Theme.hairline).frame(width: 1) }
      }
  }

  private func alignment(_ i: Int) -> HorizontalAlignment {
    switch i < aligns.count ? aligns[i] : .leading {
    case .center: .center
    case .trailing: .trailing
    case .leading: .leading
    }
  }

  private func textAlignment(_ i: Int) -> TextAlignment {
    switch i < aligns.count ? aligns[i] : .leading {
    case .center: .center
    case .trailing: .trailing
    case .leading: .leading
    }
  }
}

/// A fenced code block: language, copy button, highlighted monospaced text.
struct CodeBlock: View {
  let code: String
  let language: String?
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(language ?? "code").font(.caption.monospaced()).foregroundStyle(.secondary)
        Spacer()
        Button {
          Clipboard.copy(code)
          copied = true
          Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
          }
        } label: {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            .font(.caption)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("code-copy")
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      Divider()
      ScrollView(.horizontal, showsIndicators: false) {
        Text(CodeText.highlight(code, language: language))
          .font(.callout.monospaced())
          .textSelection(.enabled)
          .padding(12)
      }
    }
    .background(Theme.codeBackground, in: .rect(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.hairline))
    .axContainer("code-block")
  }
}

/// Inline highlighted code without chrome (tool cards).
struct CodeText: View {
  let code: String
  let language: String?
  init(_ code: String, language: String?) {
    self.code = code
    self.language = language
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Text(Self.highlight(code, language: language))
        .font(.caption.monospaced())
        .textSelection(.enabled)
        .padding(8)
    }
    .background(Theme.codeBackground, in: .rect(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline))
  }

  static func highlight(_ code: String, language: String?) -> AttributedString {
    var out = AttributedString()
    for t in Syntax.tokens(code, language: language) {
      var part = AttributedString(t.text)
      switch t.kind {
      case .keyword: part.foregroundColor = Theme.codeKeyword
      case .string: part.foregroundColor = Theme.codeString
      case .comment: part.foregroundColor = Theme.codeComment
      case .number: part.foregroundColor = Theme.codeNumber
      case .type: part.foregroundColor = Theme.codeType
      case .plain: break
      }
      out += part
    }
    return out
  }
}
