import Foundation

#if canImport(Glibc)
  import Glibc
#elseif canImport(Darwin)
  import Darwin
#endif

/// A minimal RFC 6455 client over a plain TCP socket (`ws://` only). It exists
/// so the transport runs on Linux, where URLSession has no WebSocket support
/// without a libcurl built for it; the end-to-end tests use it against a
/// daemon on loopback. Apps use `URLSessionWebSocketFactory`.
public struct POSIXWebSocketFactory: WebSocketFactory {
  public init() {}
  public func connect(to url: URL) async throws -> WebSocket {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<WebSocket, Error>) in
      Thread.detachNewThread {
        do { c.resume(returning: try POSIXWebSocket.open(url)) } catch { c.resume(throwing: error) }
      }
    }
  }
}

struct POSIXSocketError: Error, CustomStringConvertible {
  var description: String
}

final class POSIXWebSocket: WebSocket, @unchecked Sendable {
  private let fd: Int32
  private let lock = NSLock()
  private let writeLock = NSLock()
  private var inbox: [Data] = []
  private var waiter: CheckedContinuation<Data, Error>?
  private var closed: WebSocketClosed?
  private var leftover: [UInt8]

  private init(fd: Int32, leftover: [UInt8]) {
    self.fd = fd
    self.leftover = leftover
  }

  static func open(_ url: URL) throws -> POSIXWebSocket {
    guard url.scheme == "ws", let host = url.host else { throw POSIXSocketError(description: "only ws:// URLs") }
    let port = url.port ?? 80
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    #if canImport(Darwin)
      hints.ai_socktype = SOCK_STREAM
    #else
      hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
    #endif
    var res: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, String(port), &hints, &res) == 0, let first = res else {
      throw POSIXSocketError(description: "cannot resolve \(host)")
    }
    defer { freeaddrinfo(res) }
    var fd: Int32 = -1
    var ai: UnsafeMutablePointer<addrinfo>? = first
    while let a = ai {
      fd = socket(a.pointee.ai_family, a.pointee.ai_socktype, a.pointee.ai_protocol)
      if fd >= 0 {
        if connect(fd, a.pointee.ai_addr, a.pointee.ai_addrlen) == 0 { break }
        _ = closeFD(fd)
        fd = -1
      }
      ai = a.pointee.ai_next
    }
    guard fd >= 0 else { throw POSIXSocketError(description: "connection refused") }
    var one: Int32 = 1
    _ = setsockopt(fd, Int32(IPPROTO_TCP), TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
    #if canImport(Darwin)
      _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    #endif

    var keyBytes = [UInt8](repeating: 0, count: 16)
    for i in 0..<16 { keyBytes[i] = UInt8.random(in: 0...255) }
    let key = Data(keyBytes).base64EncodedString()
    var path = url.path.isEmpty ? "/" : url.path
    if let q = url.query { path += "?\(q)" }
    let req =
      "GET \(path) HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n"
    try writeAll(fd, Array(req.utf8))

    // Read the response head.
    var buf: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 4096)
    let end: [UInt8] = [13, 10, 13, 10]
    var headEnd: Int?
    while headEnd == nil {
      let n = read(fd, &chunk, chunk.count)
      if n <= 0 {
        _ = closeFD(fd)
        throw POSIXSocketError(description: "handshake failed")
      }
      buf.append(contentsOf: chunk[0..<n])
      if buf.count >= 4 {
        for i in 0...(buf.count - 4) where Array(buf[i..<i + 4]) == end {
          headEnd = i + 4
          break
        }
      }
    }
    let head = String(decoding: buf[0..<headEnd!], as: UTF8.self)
    guard head.hasPrefix("HTTP/1.1 101") else {
      _ = closeFD(fd)
      let status = head.split(separator: "\r\n").first.map(String.init) ?? head
      throw POSIXSocketError(description: "upgrade refused: \(status)")
    }
    let ws = POSIXWebSocket(fd: fd, leftover: Array(buf[headEnd!...]))
    Thread.detachNewThread { ws.readLoop() }
    return ws
  }

  private static func writeAll(_ fd: Int32, _ bytes: [UInt8]) throws {
    var off = 0
    while off < bytes.count {
      let n = bytes[off...].withUnsafeBytes { p in
        #if canImport(Darwin)
          write(fd, p.baseAddress, p.count)
        #else
          Glibc.send(fd, p.baseAddress, p.count, Int32(MSG_NOSIGNAL))
        #endif
      }
      if n <= 0 {
        if errno == EINTR { continue }
        throw WebSocketClosed(code: nil, reason: "write failed")
      }
      off += n
    }
  }

  @discardableResult
  private static func closeFD(_ fd: Int32) -> Int32 {
    #if canImport(Darwin)
      Darwin.close(fd)
    #else
      Glibc.close(fd)
    #endif
  }

  // MARK: reading

  private func readExactly(_ count: Int) -> [UInt8]? {
    var out: [UInt8] = []
    out.reserveCapacity(count)
    if !leftover.isEmpty {
      let take = min(count, leftover.count)
      out.append(contentsOf: leftover[0..<take])
      leftover.removeFirst(take)
    }
    var chunk = [UInt8](repeating: 0, count: min(1 << 16, max(count, 1)))
    while out.count < count {
      let want = min(chunk.count, count - out.count)
      let n = read(fd, &chunk, want)
      if n < 0, errno == EINTR { continue }
      if n <= 0 { return nil }
      out.append(contentsOf: chunk[0..<n])
    }
    return out
  }

  private func readLoop() {
    var message: [UInt8] = []
    var closeCode: Int?
    loop: while true {
      guard let h = readExactly(2) else { break }
      let fin = h[0] & 0x80 != 0
      let opcode = h[0] & 0x0F
      let masked = h[1] & 0x80 != 0
      var len = Int(h[1] & 0x7F)
      if len == 126 {
        guard let e = readExactly(2) else { break }
        len = Int(e[0]) << 8 | Int(e[1])
      } else if len == 127 {
        guard let e = readExactly(8) else { break }
        len = e.reduce(0) { $0 << 8 | Int($1) }
      }
      var mask: [UInt8] = []
      if masked {
        guard let m = readExactly(4) else { break }
        mask = m
      }
      guard var payload = readExactly(len) else { break }
      if masked { for i in 0..<payload.count { payload[i] ^= mask[i % 4] } }
      switch opcode {
      case 0x0, 0x1, 0x2:
        message.append(contentsOf: payload)
        if fin {
          deliver(Data(message))
          message = []
        }
      case 0x8:
        if payload.count >= 2 { closeCode = Int(payload[0]) << 8 | Int(payload[1]) }
        try? sendFrame(opcode: 0x8, payload: Array(payload.prefix(2)))
        break loop
      case 0x9:
        try? sendFrame(opcode: 0xA, payload: payload)
      default:
        break
      }
    }
    _ = POSIXWebSocket.closeFD(fd)
    finish(WebSocketClosed(code: closeCode ?? 1006, reason: closeCode == nil ? "connection lost" : "closed"))
  }

  private func deliver(_ d: Data) {
    let w: CheckedContinuation<Data, Error>? = lock.withLock {
      if let w = waiter {
        waiter = nil
        return w
      }
      inbox.append(d)
      return nil
    }
    w?.resume(returning: d)
  }

  private func finish(_ e: WebSocketClosed) {
    let w: CheckedContinuation<Data, Error>? = lock.withLock {
      if closed == nil { closed = e }
      defer { waiter = nil }
      return waiter
    }
    w?.resume(throwing: e)
  }

  func receive() async throws -> Data {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, Error>) in
      let result: Result<Data, Error>? = lock.withLock {
        if !inbox.isEmpty { return .success(inbox.removeFirst()) }
        if let closed { return .failure(closed) }
        waiter = c
        return nil
      }
      if let result { c.resume(with: result) }
    }
  }

  // MARK: writing

  private func sendFrame(opcode: UInt8, payload: [UInt8]) throws {
    var frame: [UInt8] = [0x80 | opcode]
    let n = payload.count
    if n < 126 {
      frame.append(0x80 | UInt8(n))
    } else if n < 65536 {
      frame.append(0x80 | 126)
      frame.append(UInt8(n >> 8))
      frame.append(UInt8(n & 0xFF))
    } else {
      frame.append(0x80 | 127)
      for i in (0..<8).reversed() { frame.append(UInt8((n >> (i * 8)) & 0xFF)) }
    }
    let mask = (0..<4).map { _ in UInt8.random(in: 0...255) }
    frame.append(contentsOf: mask)
    frame.reserveCapacity(frame.count + n)
    for i in 0..<n { frame.append(payload[i] ^ mask[i % 4]) }
    try writeLock.withLock { try POSIXWebSocket.writeAll(fd, frame) }
  }

  func send(_ text: String) async throws {
    if let closed = lock.withLock({ closed }) { throw closed }
    try sendFrame(opcode: 0x1, payload: Array(text.utf8))
  }

  func close(code: Int) {
    if lock.withLock({ closed }) != nil { return }
    try? sendFrame(opcode: 0x8, payload: [UInt8(code >> 8 & 0xFF), UInt8(code & 0xFF)])
    _ = shutdown(fd, Int32(SHUT_RDWR))
  }

  var bufferedAmount: Int { 0 }
}
