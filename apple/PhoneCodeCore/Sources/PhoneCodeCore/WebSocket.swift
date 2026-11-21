import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// One open WebSocket carrying text frames. `receive` is called by a single
/// reader at a time; `send` may be called from anywhere.
public protocol WebSocket: AnyObject, Sendable {
  func send(_ text: String) async throws
  /// The next text frame. Throws `WebSocketClosed` once the socket is closed.
  func receive() async throws -> Data
  func close(code: Int)
  /// Bytes queued but not yet handed to the network, when known.
  var bufferedAmount: Int { get }
}

public struct WebSocketClosed: Error, Sendable, Equatable {
  public var code: Int?
  public var reason: String
  public init(code: Int?, reason: String = "") {
    self.code = code
    self.reason = reason
  }
}

public protocol WebSocketFactory: Sendable {
  func connect(to url: URL) async throws -> WebSocket
}

public enum WebSockets {
  /// The platform's preferred implementation: `URLSessionWebSocketTask` on
  /// Apple platforms, the small POSIX client elsewhere (Linux, where
  /// swift-corelibs URLSession depends on a libcurl built with WebSocket support).
  /// `PHONECODE_WS=posix` forces the POSIX client (used by the tests on macOS too).
  public static var platformDefault: WebSocketFactory {
    #if canImport(Darwin)
      if ProcessInfo.processInfo.environment["PHONECODE_WS"] == "posix" { return POSIXWebSocketFactory() }
      return URLSessionWebSocketFactory()
    #else
      return POSIXWebSocketFactory()
    #endif
  }
}

#if canImport(Darwin)
  /// `URLSessionWebSocketTask`, the system implementation (TLS, proxies, HTTP/2 aware).
  public struct URLSessionWebSocketFactory: WebSocketFactory {
    public init() {}
    public func connect(to url: URL) async throws -> WebSocket {
      let s = URLSessionSocket(url: url)
      try await s.open()
      return s
    }
  }

  final class URLSessionSocket: NSObject, WebSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private var openContinuation: CheckedContinuation<Void, Error>?
    private var closedCode: Int?

    init(url: URL) {
      super.init()
      let config = URLSessionConfiguration.default
      config.waitsForConnectivity = false
      config.timeoutIntervalForRequest = 15
      session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
      task = session.webSocketTask(with: url)
      // Snapshots of long chats are large; the default limit is 1 MB.
      task.maximumMessageSize = 64 * 1024 * 1024
    }

    func open() async throws {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        lock.withLock { openContinuation = c }
        task.resume()
      }
    }

    private func finishOpen(_ error: Error?) {
      let c: CheckedContinuation<Void, Error>? = lock.withLock {
        defer { openContinuation = nil }
        return openContinuation
      }
      if let error { c?.resume(throwing: error) } else { c?.resume() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
      finishOpen(nil)
    }

    func urlSession(
      _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
      didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
      lock.withLock { closedCode = closeCode.rawValue }
      finishOpen(WebSocketClosed(code: closeCode.rawValue))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      finishOpen(error ?? WebSocketClosed(code: nil, reason: "closed"))
      session.finishTasksAndInvalidate()
    }

    func send(_ text: String) async throws {
      try await task.send(.string(text))
    }

    func receive() async throws -> Data {
      do {
        switch try await task.receive() {
        case .string(let s): return Data(s.utf8)
        case .data(let d): return d
        @unknown default: return Data()
        }
      } catch {
        let code = lock.withLock { closedCode } ?? (task.closeCode.rawValue == 0 ? nil : task.closeCode.rawValue)
        throw WebSocketClosed(code: code, reason: error.localizedDescription)
      }
    }

    func close(code: Int) {
      task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
    }

    var bufferedAmount: Int {
      Int(max(0, task.countOfBytesExpectedToSend - task.countOfBytesSent))
    }
  }
#endif
