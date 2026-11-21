import Foundation
import PhoneCodeCore
import Testing

/// The Mac app as the hub: it reaches the daemon on the same computer through
/// the local control endpoint, connects without a typed code, pairs phones and
/// revokes them.
@Suite("Local daemon (Mac hub) against the real daemon", .serialized, .timeLimit(.minutes(2)))
@MainActor
struct HubTests {
  @Test("find, connect without a code, mint phone codes, list and revoke devices")
  func hub() async throws {
    try await withDaemon { d in
      // Nothing answers in an empty state directory.
      let empty = FileManager.default.temporaryDirectory.appendingPathComponent("pc-hub-empty-\(UUID().uuidString)")
      #expect(await LocalDaemon.find(in: empty) == nil)
      #expect(LocalDaemon.stateDirectory(environment: ["PHONECODE_HOME": d.home.path]).standardizedFileURL.path == d.home.standardizedFileURL.path)
      #expect(LocalDaemon.stateDirectory(environment: ["HOME": "/Users/x"]).path == "/Users/x/.phonecode")

      let hub = try #require(await LocalDaemon.find(in: d.home))
      #expect(hub.control.port == d.url.port)
      let status = try await hub.status()
      #expect(status.port == d.url.port)

      // The Mac app connects itself.
      let mac = try await hub.pairThisApp(deviceName: "Mac hub")
      let client = PhoneCodeClient()
      client.start(mac)
      try await waitUntil("mac connected") { client.status == .open && client.sessionsLoaded }

      // A phone pairs with the code the Mac shows.
      let code = try await hub.newPairCode()
      // The QR link carries its own secret; the code is what a person types.
      let link = try #require(PairingLink.parse(code.pairUrl))
      #expect(!link.code.isEmpty && !code.code.isEmpty)
      #expect(code.expires.map { $0 > Date() } ?? true)
      let phone = try await PairingClient().pair(origin: d.url, code: code.code, deviceName: "Phone")

      let devices = try await hub.devices()
      #expect(Set(devices.map(\.name)).isSuperset(of: ["Mac hub", "Phone"]))
      #expect(devices.contains { $0.id == phone.deviceId })

      // Revoking the phone signs it out and leaves the Mac connected.
      try await hub.revoke(phone.deviceId)
      #expect(try await !hub.devices().contains { $0.id == phone.deviceId })
      await #expect(throws: PairingError.self) { _ = try await PairingClient().handoff(phone) }
      #expect(client.status == .open)

      // A wrong control token is refused.
      var forged = hub.control
      forged.token = "not-the-token"
      await #expect(throws: PairingError.self) { _ = try await LocalDaemon(control: forged).newPairCode() }
      client.stop()
    }
  }
}
