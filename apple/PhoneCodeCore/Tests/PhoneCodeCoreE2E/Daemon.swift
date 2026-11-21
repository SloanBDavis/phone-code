import Foundation
import PhoneCodeCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif
#if canImport(Glibc)
  import Glibc
#elseif canImport(Darwin)
  import Darwin
#endif

/// Spawns a real phone-code daemon for one test, the way e2e/lib/daemon.ts
/// does: `--local`, its own temp PHONECODE_HOME and HOME, PHONECODE_JSON=1 and
/// the scripted fake agents from e2e/fakes.
final class Daemon: @unchecked Sendable {
  static let repo: URL = {
    // apple/PhoneCodeCore/Tests/PhoneCodeCoreE2E/Daemon.swift -> repo root
    var u = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { u.deleteLastPathComponent() }
    return u
  }()

  let root: URL
  let home: URL
  let userHome: URL
  let project: URL
  private(set) var port = 0
  private(set) var url = URL(string: "http://127.0.0.1")!
  private(set) var pairCode = ""
  private var process: Process?
  private let extraEnv: [String: String]
  private let lock = NSLock()
  private var outputBuf = ""

  var output: String { lock.withLock { outputBuf } }

  private init(env: [String: String]) throws {
    extraEnv = env
    root = FileManager.default.temporaryDirectory.appendingPathComponent("phonecode-swift-e2e-\(UUID().uuidString.prefix(8))")
    home = root.appendingPathComponent("state")
    userHome = root.appendingPathComponent("home")
    project = userHome.appendingPathComponent("project")
    let fm = FileManager.default
    try fm.createDirectory(at: project.appendingPathComponent("src"), withIntermediateDirectories: true)
    try fm.createDirectory(at: userHome.appendingPathComponent("other"), withIntermediateDirectories: true)
    try "# project\n".write(to: project.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
    try "PS1='$ '\n".write(to: userHome.appendingPathComponent(".bashrc"), atomically: true, encoding: .utf8)
    try ". ~/.bashrc\n".write(to: userHome.appendingPathComponent(".bash_profile"), atomically: true, encoding: .utf8)
  }

  static func start(env: [String: String] = [:]) async throws -> Daemon {
    let d = try Daemon(env: env)
    d.port = try freePort()
    try await d.launch()
    return d
  }

  static func freePort() throws -> Int {
    #if canImport(Darwin)
      let fd = socket(AF_INET, SOCK_STREAM, 0)
    #else
      let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
    #endif
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    addr.sin_port = 0
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let ok = withUnsafeMutablePointer(to: &addr) { p in
      p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
        bind(fd, sp, len) == 0 && getsockname(fd, sp, &len) == 0
      }
    }
    guard ok else { throw E2EError("no free port") }
    return Int(UInt16(bigEndian: addr.sin_port))
  }

  var fakes: URL { Daemon.repo.appendingPathComponent("e2e/fakes") }

  func environment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment.filter { k, _ in
      !k.hasPrefix("PHONECODE_") && !k.hasPrefix("CLAUDE") && !k.hasPrefix("CODEX")
    }
    env["HOME"] = userHome.path
    env["SHELL"] = "/bin/bash"
    env["USER"] = "tester"
    env["PHONECODE_HOME"] = home.path
    env["PHONECODE_JSON"] = "1"
    env["PHONECODE_CLAUDE_BIN"] = fakes.appendingPathComponent("fake-claude.mjs").path
    env["PHONECODE_CODEX_BIN"] = fakes.appendingPathComponent("fake-codex.mjs").path
    env["PHONECODE_GEMINI_BIN"] = fakes.appendingPathComponent("fake-acp.mjs").path
    env["CLAUDE_CONFIG_DIR"] = userHome.appendingPathComponent(".claude").path
    env["CODEX_HOME"] = userHome.appendingPathComponent(".codex").path
    env["FAKE_SPEED"] = "2"
    env["FAKE_ACP_HOME"] = root.appendingPathComponent("fake-acp").path
    for (k, v) in extraEnv { env[k] = v }
    return env
  }

  static func bun() -> String {
    let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin"
    for dir in path.split(separator: ":") {
      let p = "\(dir)/bun"
      if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
    return "\(home)/.bun/bin/bun"
  }

  private func launch() async throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: Daemon.bun())
    p.arguments = [Daemon.repo.appendingPathComponent("packages/daemon/src/cli.ts").path, "--local", "--port", String(port)]
    p.currentDirectoryURL = userHome
    p.environment = environment()
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    p.standardInput = FileHandle.nullDevice
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      guard let self, !d.isEmpty else { return }
      self.lock.withLock { self.outputBuf += String(decoding: d, as: UTF8.self) }
    }
    try p.run()
    process = p
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      if let r = readyLine() {
        guard let j = try? JSONDecoder().decode([String: JSONValue].self, from: Data(r.utf8)),
          let u = j["url"]?.stringValue, let code = j["pairCode"]?.stringValue
        else { throw E2EError("bad ready line \(r)") }
        url = URL(string: u)!
        pairCode = code
        return
      }
      if !p.isRunning { throw E2EError("daemon exited:\n\(output)") }
      try await Task.sleep(for: .milliseconds(50))
    }
    throw E2EError("daemon did not start:\n\(output)")
  }

  private func readyLine() -> String? {
    let o = output
    guard let r = o.range(of: "PHONECODE_READY ") else { return nil }
    let rest = o[r.upperBound...]
    guard let nl = rest.firstIndex(of: "\n") else { return nil }
    return String(rest[..<nl])
  }

  func stop() async {
    guard let p = process else { return }
    process = nil
    if p.isRunning { p.terminate() }
    let deadline = Date().addingTimeInterval(8)
    while p.isRunning, Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    (p.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
  }

  func restart() async throws {
    await stop()
    lock.withLock { outputBuf = "" }
    try await launch()
  }

  func dispose() async {
    await stop()
    try? FileManager.default.removeItem(at: root)
  }

  /// Creates `HOME/<name>` and returns its path.
  func folder(_ name: String) -> String {
    let u = userHome.appendingPathComponent(name)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u.path
  }

  // MARK: control API (like `phonecode pair` / `phonecode revoke`)

  private func control(_ method: String, _ path: String) async throws -> [String: JSONValue] {
    let raw = try Data(contentsOf: home.appendingPathComponent("control.json"))
    let c = try JSONDecoder().decode([String: JSONValue].self, from: raw)
    guard let port = c["port"]?.doubleValue, let token = c["token"]?.stringValue else { throw E2EError("control.json") }
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(Int(port))\(path)")!)
    req.httpMethod = method
    req.setValue(token, forHTTPHeaderField: "x-phonecode-control")
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    let (d, _) = try await URLSession.shared.data(for: req)
    return try JSONDecoder().decode([String: JSONValue].self, from: d)
  }

  /// A fresh single-use pairing code and its link.
  func newPairCode() async throws -> (code: String, pairUrl: String) {
    let r = try await control("POST", "/_control/pair")
    return (r["code"]?.stringValue ?? "", r["pairUrl"]?.stringValue ?? "")
  }

  /// Runs the real CLI (`phonecode <args>`) against this daemon's state.
  func cli(_ args: String...) async throws -> (code: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: Daemon.bun())
    p.arguments = [Daemon.repo.appendingPathComponent("packages/daemon/src/cli.ts").path] + args
    p.environment = environment()
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
  }
}

struct E2EError: Error, CustomStringConvertible {
  var description: String
  init(_ d: String) { description = d }
}
