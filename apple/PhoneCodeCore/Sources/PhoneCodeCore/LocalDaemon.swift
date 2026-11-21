import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// The `phonecode` daemon running on this computer, reached through its local
/// control endpoint (what `phonecode pair|devices|revoke` use): the daemon
/// writes `control.json` (port and a secret token) into its state directory,
/// and `/_control/*` answers loopback requests that carry that token.
///
/// The Mac app uses it to be the hub: it connects itself without a pairing
/// code, shows the QR code phones pair with, and lists and revokes devices.
public struct LocalDaemon: Sendable {
  public struct ControlFile: Decodable, Sendable, Equatable {
    public var pid: Int
    public var port: Int
    public var token: String
  }

  public struct Status: Decodable, Sendable, Equatable {
    /// The address phones use (Tailscale, LAN or tunnel), when the daemon has one.
    public var url: String?
    public var port: Int
    public var pid: Int
  }

  public struct PairCode: Decodable, Sendable, Equatable {
    public var code: String
    public var pairUrl: String
    /// Milliseconds since 1970.
    public var expiresAt: Double?

    public var expires: Date? { expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
  }

  public struct Device: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var lastSeenAt: Double
    /// Push subscriptions this device registered.
    public var push: Int
    /// The device this one was paired through (handoff), if any.
    public var parent: String?

    public var lastSeen: Date { Date(timeIntervalSince1970: lastSeenAt / 1000) }
  }

  public let control: ControlFile
  private let session: URLSession

  /// The local origin to connect to (loopback, so no TLS is needed).
  public var origin: URL { URL(string: "http://127.0.0.1:\(control.port)")! }

  /// The daemon's state directory: `$PHONECODE_HOME`, else `~/.phonecode`
  /// (the same rule as the daemon's `stateDir()`).
  public static func stateDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
    if let h = environment["PHONECODE_HOME"], !h.isEmpty { return URL(fileURLWithPath: h, isDirectory: true) }
    let home = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
    return URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent(".phonecode", isDirectory: true)
  }

  /// Reads `control.json`; nil when the daemon has never run here.
  public static func readControlFile(in dir: URL = stateDirectory()) -> ControlFile? {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("control.json")),
      let c = try? JSONDecoder().decode(ControlFile.self, from: data), c.port > 0, !c.token.isEmpty
    else { return nil }
    return c
  }

  public init(control: ControlFile, session: URLSession? = nil) {
    self.control = control
    self.session = session ?? LocalDaemon.makeSession()
  }

  private static func makeSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 4
    config.urlCache = nil
    return URLSession(configuration: config)
  }

  /// The running daemon on this computer, or nil when none answers.
  public static func find(in dir: URL = stateDirectory()) async -> LocalDaemon? {
    guard let c = readControlFile(in: dir) else { return nil }
    let d = LocalDaemon(control: c)
    return (try? await d.status()) != nil ? d : nil
  }

  private func call(_ method: String, _ path: String, body: [String: String]? = nil) async throws -> Data {
    var req = URLRequest(url: origin.appendingPathComponent(path))
    req.httpMethod = method
    req.setValue(control.token, forHTTPHeaderField: "x-phonecode-control")
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    if let body { req.httpBody = try JSONEncoder().encode(body) }
    let (data, res): (Data, URLResponse)
    do {
      (data, res) = try await session.data(for: req)
    } catch {
      throw PairingError(message: "phone-code is not running on this Mac.", status: 0)
    }
    let status = (res as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw PairingError(message: "phone-code on this Mac refused the request (\(status)).", status: status)
    }
    return data
  }

  public func status() async throws -> Status {
    try JSONDecoder().decode(Status.self, from: await call("GET", "_control/status"))
  }

  /// A fresh pairing code and link (what `phonecode pair` prints).
  public func newPairCode() async throws -> PairCode {
    try JSONDecoder().decode(PairCode.self, from: await call("POST", "_control/pair"))
  }

  public func devices() async throws -> [Device] {
    struct List: Decodable { var devices: [Device] }
    return try JSONDecoder().decode(List.self, from: await call("GET", "_control/devices")).devices
  }

  /// Revokes a device and every device paired through it.
  public func revoke(_ id: String) async throws {
    _ = try await call("POST", "_control/revoke", body: ["id": id])
  }

  /// Pairs this app with the local daemon: mints a code and redeems it.
  public func pairThisApp(deviceName: String, pairing: PairingClient = PairingClient()) async throws -> HostCredentials {
    let code = try await newPairCode()
    return try await pairing.pair(origin: origin, code: code.code, deviceName: deviceName)
  }
}
