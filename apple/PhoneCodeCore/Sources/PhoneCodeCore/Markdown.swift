import Foundation

/// Block structure of an agent's markdown. Inline markup (emphasis, code
/// spans, links) stays in the strings and is rendered by the app with
/// `AttributedString(markdown:)`. Built for streaming: an unterminated code
/// fence is still a code block, and re-parsing one message per delta is cheap.
public enum MarkdownBlock: Hashable, Sendable {
  case heading(level: Int, text: String)
  case paragraph(String)
  case code(language: String?, code: String)
  case list(ordered: Bool, items: [MarkdownListItem])
  case quote(String)
  case table(header: [String], alignments: [MarkdownAlignment], rows: [[String]])
  case rule
}

public struct MarkdownListItem: Hashable, Sendable {
  public var text: String
  /// For ordered lists, the item's number.
  public var number: Int?
  /// Task list: `- [ ]` / `- [x]`.
  public var checked: Bool?
  /// Nesting depth (0 = top level).
  public var depth: Int
}

public enum MarkdownAlignment: String, Hashable, Sendable { case leading, center, trailing }

public enum Markdown {
  public static func blocks(_ source: String) -> [MarkdownBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var out: [MarkdownBlock] = []
    var para: [String] = []
    var i = 0

    func flush() {
      if !para.isEmpty {
        out.append(.paragraph(para.joined(separator: "\n")))
        para = []
      }
    }

    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      // Fenced code (``` or ~~~), possibly still streaming.
      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        flush()
        let fence = String(trimmed.prefix(3))
        let lang = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
        var code: [String] = []
        i += 1
        while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
          code.append(lines[i])
          i += 1
        }
        i += 1
        out.append(.code(language: lang.isEmpty ? nil : lang.split(separator: " ").first.map(String.init), code: code.joined(separator: "\n")))
        continue
      }
      if trimmed.isEmpty {
        flush()
        i += 1
        continue
      }
      // Heading.
      if trimmed.hasPrefix("#") {
        let level = trimmed.prefix { $0 == "#" }.count
        if level <= 6, trimmed.dropFirst(level).first == " " || trimmed.count == level {
          flush()
          out.append(.heading(level: level, text: trimmed.dropFirst(level).trimmingCharacters(in: .whitespaces)))
          i += 1
          continue
        }
      }
      // Rule.
      let compact = trimmed.replacingOccurrences(of: " ", with: "")
      if compact.count >= 3, Set(compact).count == 1, ["-", "*", "_"].contains(compact.first!) {
        flush()
        out.append(.rule)
        i += 1
        continue
      }
      // Table: a header row followed by a delimiter row.
      if trimmed.contains("|"), i + 1 < lines.count, isDelimiterRow(lines[i + 1]) {
        flush()
        let header = cells(trimmed)
        let aligns = cells(lines[i + 1]).map { c -> MarkdownAlignment in
          let l = c.hasPrefix(":")
          let r = c.hasSuffix(":")
          return l && r ? .center : r ? .trailing : .leading
        }
        var rows: [[String]] = []
        i += 2
        while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
          var r = cells(lines[i])
          if r.count < header.count { r += Array(repeating: "", count: header.count - r.count) }
          rows.append(Array(r.prefix(header.count)))
          i += 1
        }
        out.append(.table(header: header, alignments: aligns + Array(repeating: .leading, count: max(0, header.count - aligns.count)), rows: rows))
        continue
      }
      // Quote.
      if trimmed.hasPrefix(">") {
        flush()
        var q: [String] = []
        while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
          q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
          i += 1
        }
        out.append(.quote(q.joined(separator: "\n")))
        continue
      }
      // Lists.
      if listMarker(line) != nil {
        flush()
        var items: [MarkdownListItem] = []
        let ordered = listMarker(line)!.ordered
        while i < lines.count, let m = listMarker(lines[i]) {
          var text = m.text
          var checked: Bool?
          if text.hasPrefix("[ ] ") {
            checked = false
            text.removeFirst(4)
          } else if text.lowercased().hasPrefix("[x] ") {
            checked = true
            text.removeFirst(4)
          }
          i += 1
          // Lazy continuation lines belong to the item.
          while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, listMarker(lines[i]) == nil,
            lines[i].hasPrefix("  ")
          {
            text += "\n" + lines[i].trimmingCharacters(in: .whitespaces)
            i += 1
          }
          items.append(MarkdownListItem(text: text, number: m.number, checked: checked, depth: m.indent / 2))
        }
        out.append(.list(ordered: ordered, items: items))
        continue
      }
      para.append(line)
      i += 1
    }
    flush()
    return out
  }

  private static func listMarker(_ line: String) -> (ordered: Bool, number: Int?, text: String, indent: Int)? {
    let indent = line.prefix { $0 == " " }.count
    let rest = line.dropFirst(indent)
    if let f = rest.first, "-*+".contains(f), rest.dropFirst().first == " " {
      return (false, nil, String(rest.dropFirst(2)), indent)
    }
    let digits = rest.prefix { $0.isNumber }
    if !digits.isEmpty, digits.count < 10 {
      let after = rest.dropFirst(digits.count)
      if let d = after.first, d == "." || d == ")", after.dropFirst().first == " " {
        return (true, Int(digits), String(after.dropFirst(2)), indent)
      }
    }
    return nil
  }

  private static func isDelimiterRow(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    guard t.contains("-"), t.contains("|") || t.hasPrefix(":") || t.hasPrefix("-") else { return false }
    return t.allSatisfy { "|-: ".contains($0) }
  }

  private static func cells(_ line: String) -> [String] {
    var t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("|") { t.removeFirst() }
    if t.hasSuffix("|") { t.removeLast() }
    return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
  }
}

// MARK: - Syntax highlighting

/// A tiny lexer for code blocks: comments, strings, numbers and keywords for
/// the languages agents print most. Good enough to read code on a phone.
public enum Syntax {
  public enum Kind: Hashable, Sendable { case plain, keyword, string, comment, number, type }

  public struct Token: Hashable, Sendable {
    public var text: String
    public var kind: Kind
  }

  static let common: Set<String> = [
    "if", "else", "for", "while", "return", "break", "continue", "switch", "case", "default", "do", "in", "true", "false",
    "null", "nil", "import", "from", "as", "try", "catch", "throw", "new", "class", "struct", "enum", "const", "let", "var",
    "func", "function", "def", "fn", "pub", "use", "mut", "async", "await", "export", "interface", "type", "extends",
    "implements", "public", "private", "protected", "static", "self", "this", "super", "package", "go", "defer", "yield",
    "lambda", "with", "not", "and", "or", "is", "None", "True", "False", "elif", "pass", "raise", "except", "finally",
    "guard", "where", "protocol", "extension", "init", "override", "final", "undefined", "void", "typeof", "instanceof",
    "match", "impl", "trait", "mod", "crate", "loop", "then", "fi", "esac", "done", "echo", "local", "readonly", "of",
  ]

  public static func tokens(_ code: String, language: String?) -> [Token] {
    let lang = (language ?? "").lowercased()
    let hashComments = ["py", "python", "sh", "bash", "zsh", "shell", "rb", "ruby", "yaml", "yml", "toml", "r", "perl", "make", "makefile", "dockerfile", "console"].contains(lang)
    let slashComments = !hashComments || lang.isEmpty
    let sqlComments = ["sql", "lua", "haskell", "hs"].contains(lang)
    let chars = Array(code)
    var out: [Token] = []
    var buf = ""
    var i = 0

    func emit(_ s: String, _ k: Kind) {
      if k == .plain, let last = out.last, last.kind == .plain {
        out[out.count - 1].text += s
      } else if !s.isEmpty {
        out.append(Token(text: s, kind: k))
      }
    }
    func flushWord() {
      guard !buf.isEmpty else { return }
      if common.contains(buf) {
        emit(buf, .keyword)
      } else if buf.first!.isNumber {
        emit(buf, .number)
      } else if buf.first!.isUppercase, buf.count > 1, !lang.isEmpty {
        emit(buf, .type)
      } else {
        emit(buf, .plain)
      }
      buf = ""
    }

    while i < chars.count {
      let c = chars[i]
      let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
      if (slashComments && c == "/" && next == "/") || (hashComments && c == "#") || (sqlComments && c == "-" && next == "-") {
        flushWord()
        var s = ""
        while i < chars.count, chars[i] != "\n" {
          s.append(chars[i])
          i += 1
        }
        emit(s, .comment)
        continue
      }
      if slashComments, c == "/", next == "*" {
        flushWord()
        var s = "/*"
        i += 2
        while i < chars.count, !(chars[i] == "*" && i + 1 < chars.count && chars[i + 1] == "/") {
          s.append(chars[i])
          i += 1
        }
        if i < chars.count {
          s += "*/"
          i += 2
        }
        emit(s, .comment)
        continue
      }
      if c == "\"" || c == "'" || c == "`" {
        flushWord()
        var s = String(c)
        i += 1
        while i < chars.count, chars[i] != c, chars[i] != "\n" || c == "`" {
          if chars[i] == "\\", i + 1 < chars.count {
            s.append(chars[i])
            i += 1
          }
          s.append(chars[i])
          i += 1
        }
        if i < chars.count, chars[i] == c {
          s.append(c)
          i += 1
        }
        emit(s, .string)
        continue
      }
      if c.isLetter || c.isNumber || c == "_" || (c == "." && !buf.isEmpty && buf.first!.isNumber) {
        buf.append(c)
      } else {
        flushWord()
        emit(String(c), .plain)
      }
      i += 1
    }
    flushWord()
    return out
  }
}

// MARK: - Diffs

public struct DiffLine: Hashable, Sendable, Identifiable {
  public enum Kind: Hashable, Sendable { case hunk, added, removed, context, meta }
  public var id: Int
  public var kind: Kind
  public var text: String
  public var oldLine: Int?
  public var newLine: Int?
}

public enum UnifiedDiff {
  /// The lines of a unified diff with old and new line numbers.
  public static func lines(_ patch: String) -> [DiffLine] {
    var out: [DiffLine] = []
    var old = 0
    var new = 0
    let all = patch.components(separatedBy: "\n")
    for (n, raw) in all.enumerated() {
      if raw.hasPrefix("@@") {
        // @@ -a,b +c,d @@
        let parts = raw.split(separator: " ")
        if parts.count >= 3 {
          old = Int(parts[1].dropFirst().split(separator: ",").first ?? "") ?? 0
          new = Int(parts[2].dropFirst().split(separator: ",").first ?? "") ?? 0
        }
        out.append(DiffLine(id: n, kind: .hunk, text: raw))
      } else if raw.hasPrefix("+++") || raw.hasPrefix("---") || raw.hasPrefix("diff ") || raw.hasPrefix("index ") {
        out.append(DiffLine(id: n, kind: .meta, text: raw))
      } else if raw.hasPrefix("+") {
        out.append(DiffLine(id: n, kind: .added, text: String(raw.dropFirst()), newLine: new))
        new += 1
      } else if raw.hasPrefix("-") {
        out.append(DiffLine(id: n, kind: .removed, text: String(raw.dropFirst()), oldLine: old))
        old += 1
      } else if raw.hasPrefix("\\") {
        out.append(DiffLine(id: n, kind: .meta, text: raw))
      } else if !(raw.isEmpty && n == all.count - 1) {
        out.append(DiffLine(id: n, kind: .context, text: raw.isEmpty ? "" : String(raw.dropFirst()), oldLine: old, newLine: new))
        old += 1
        new += 1
      }
    }
    return out
  }
}
