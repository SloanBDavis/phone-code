import Foundation

/// Any JSON value. Used where the protocol carries `unknown` (raw tool input,
/// push subscriptions) so nothing the daemon sends is lost or crashes decoding.
public enum JSONValue: Sendable, Hashable, Codable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n):
      if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public var stringValue: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  public var doubleValue: Double? {
    if case .number(let n) = self { return n }
    return nil
  }

  /// Compact JSON text, e.g. for showing a tool's raw input.
  public var jsonText: String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let d = try? enc.encode(self) else { return "" }
    return String(decoding: d, as: UTF8.self)
  }
}

/// A string-backed enum that accepts values it does not know. A newer daemon
/// can add a status, mode or level without breaking an older app.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral
where RawValue == String {
  init(rawValue: String)
}

extension OpenEnum {
  public init(stringLiteral value: String) { self.init(rawValue: value) }
  public init(from decoder: Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
}
