import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// A pairing link from the QR code (`<url>/#/pair?c=<code>`), a pasted link,
/// an app link (`phonecode://pair?url=<origin>&c=<code>`), or a bare code.
public struct PairingLink: Hashable, Sendable {
  public var code: String
  /// The daemon's origin, when the input carried one.
  public var origin: URL?

  public init(code: String, origin: URL?) {
    self.code = code
    self.origin = origin
  }

  public static func parse(_ input: String) -> PairingLink? {
    let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    let lower = s.lowercased()
    if lower.hasPrefix("phonecode://") {
      guard let u = URLComponents(string: s) else { return nil }
      let q = u.queryItems ?? []
      guard let code = q.first(where: { $0.name == "c" || $0.name == "code" })?.value, !code.isEmpty else { return nil }
      let origin = q.first(where: { $0.name == "url" || $0.name == "host" })?.value.flatMap(originURL)
      return PairingLink(code: code, origin: origin)
    }
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
      guard let u = URLComponents(string: s) else { return nil }
      var items = u.queryItems ?? []
      if let frag = u.fragment, let qi = frag.firstIndex(of: "?") {
        items += URLComponents(string: "x:" + frag[qi...])?.queryItems ?? []
      }
      guard let code = (items.first { $0.name == "c" } ?? items.first { $0.name == "h" })?.value, !code.isEmpty else {
        return nil
      }
      var o = URLComponents()
      o.scheme = u.scheme?.lowercased()
      o.host = u.host
      o.port = u.port
      return PairingLink(code: code, origin: o.url)
    }
    let ok = s.range(of: "^[A-Za-z0-9_-]{4,128}$", options: .regularExpression) != nil
    return ok ? PairingLink(code: s, origin: nil) : nil
  }

  /// Accepts "mac.tailnet.ts.net", "https://mac.tailnet.ts.net/" or "http://127.0.0.1:7777".
  public static func originURL(_ input: String) -> URL? {
    var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
    guard let u = URLComponents(string: s), let host = u.host, !host.isEmpty else { return nil }
    var o = URLComponents()
    o.scheme = u.scheme?.lowercased()
    o.host = host
    o.port = u.port
    return o.url
  }
}

public struct PairingError: Error, Sendable, Equatable, CustomStringConvertible {
  public var message: String
  public var status: Int
  public var description: String { message }
}

/// The HTTP endpoints: pair, handoff, unpair, health.
public struct PairingClient: Sendable {
  public var session: URLSession
  public init(session: URLSession = .shared) { self.session = session }

  private func post(_ base: URL, _ path: String, body: Data?, token: String?) async throws -> Data {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.httpMethod = "POST"
    req.timeoutInterval = 15
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    req.httpBody = body ?? Data("{}".utf8)
    let data: Data
    let res: URLResponse
    do {
      (data, res) = try await session.data(for: req)
    } catch {
      throw PairingError(message: "Could not reach your computer. Is phone-code still running?", status: 0)
    }
    let status = (res as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      var msg = ""
      if let j = try? JSONDecoder().decode([String: JSONValue].self, from: data) {
        msg = j["error"]?.stringValue ?? j["message"]?.stringValue ?? ""
      }
      if msg.isEmpty {
        msg =
          [401, 403, 404, 410].contains(status)
          ? "This pairing code has expired or was already used." : "Request failed (\(status))"
      }
      throw PairingError(message: msg, status: status)
    }
    return data
  }

  /// Redeems a pairing or handoff code.
  ///
  /// `clientId` names this app (a random id it keeps): pairing again with the same one
  /// replaces its earlier entry on the computer instead of adding another.
  public func pair(origin: URL, code: String, deviceName: String, clientId: String? = nil) async throws
    -> HostCredentials
  {
    var fields = ["code": code, "deviceName": deviceName]
    if let clientId { fields["clientId"] = clientId }
    let body = try JSONEncoder().encode(fields)
    let data = try await post(origin, "api/pair", body: body, token: nil)
    guard let r = try? JSONDecoder().decode(PairResponse.self, from: data) else {
      throw PairingError(message: "Unexpected answer from your computer. Update phone-code?", status: 200)
    }
    return HostCredentials(baseURL: origin, token: r.token, deviceId: r.deviceId, hostName: r.host.name)
  }

  /// A short-lived single-use code another of the user's apps can redeem.
  public func handoff(_ creds: HostCredentials) async throws -> HandoffResponse {
    let data = try await post(creds.baseURL, "api/handoff", body: nil, token: creds.token)
    guard let r = try? JSONDecoder().decode(HandoffResponse.self, from: data) else {
      throw PairingError(message: "Unexpected answer from your computer.", status: 200)
    }
    return r
  }

  /// Asks the host to forget this device; its token stops working.
  public func unpair(_ creds: HostCredentials) async throws {
    _ = try await post(creds.baseURL, "api/unpair", body: nil, token: creds.token)
  }

  /// `GET /api/health`: the daemon's version, or nil when it cannot be reached.
  public func health(_ origin: URL) async -> String? {
    var req = URLRequest(url: origin.appendingPathComponent("api/health"))
    req.timeoutInterval = 8
    guard let (data, _) = try? await session.data(for: req),
      let j = try? JSONDecoder().decode([String: JSONValue].self, from: data)
    else { return nil }
    return j["version"]?.stringValue ?? "unknown"
  }
}
