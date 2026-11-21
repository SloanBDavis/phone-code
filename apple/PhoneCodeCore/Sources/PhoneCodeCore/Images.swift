import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Fetches session images (`GET /api/sessions/<id>/images/<imageId>[?w=px]`)
/// with the bearer token, coalesces concurrent requests and keeps the bytes in
/// a size-bounded LRU cache. Decoding to UIImage/NSImage is the app's job.
public actor ImageLoader {
  private let creds: HostCredentials
  private let session: URLSession
  private let limit: Int
  private var cache: [String: Data] = [:]
  private var order: [String] = []
  private var bytes = 0
  private var inflight: [String: Task<Data, Error>] = [:]

  /// `session` defaults to one without a URL cache: this loader keeps its own
  /// cache per paired device, and the daemon marks images `immutable`, so a
  /// shared URLCache would keep serving them after the device is unpaired.
  public init(credentials: HostCredentials, session: URLSession? = nil, cacheBytes: Int = 48 * 1024 * 1024) {
    self.creds = credentials
    self.session = session ?? ImageLoader.uncachedSession()
    self.limit = cacheBytes
  }

  static func uncachedSession() -> URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: c)
  }

  public nonisolated func url(sessionId: String, imageId: String, width: Int? = nil) -> URL {
    var u = creds.baseURL
    u.appendPathComponent("api")
    u.appendPathComponent("sessions")
    u.appendPathComponent(sessionId)
    u.appendPathComponent("images")
    u.appendPathComponent(imageId)
    guard let width, var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else { return u }
    c.queryItems = [URLQueryItem(name: "w", value: String(width))]
    return c.url ?? u
  }

  /// The image bytes; `width` asks the daemon for a downscaled thumbnail.
  public func data(sessionId: String, imageId: String, width: Int? = nil) async throws -> Data {
    let key = "\(sessionId)/\(imageId)/\(width ?? 0)"
    if let d = cache[key] {
      touch(key)
      return d
    }
    if let t = inflight[key] { return try await t.value }
    let req = request(url(sessionId: sessionId, imageId: imageId, width: width))
    let s = session
    let t = Task<Data, Error> {
      let (d, res) = try await s.data(for: req)
      let status = (res as? HTTPURLResponse)?.statusCode ?? 0
      guard status == 200 else { throw RpcError("Image not available (\(status))") }
      return d
    }
    inflight[key] = t
    defer { inflight[key] = nil }
    let d = try await t.value
    store(key, d)
    return d
  }

  public nonisolated func request(_ url: URL) -> URLRequest {
    var r = URLRequest(url: url)
    r.setValue("Bearer \(creds.token)", forHTTPHeaderField: "authorization")
    r.timeoutInterval = 30
    return r
  }

  private func touch(_ key: String) {
    if let i = order.firstIndex(of: key) { order.remove(at: i) }
    order.append(key)
  }

  private func store(_ key: String, _ d: Data) {
    guard d.count < limit / 2 else { return }
    if let old = cache[key] { bytes -= old.count }
    cache[key] = d
    bytes += d.count
    touch(key)
    while bytes > limit, let first = order.first {
      order.removeFirst()
      if let old = cache.removeValue(forKey: first) { bytes -= old.count }
    }
  }

  public func cachedCount() -> Int { cache.count }
}
