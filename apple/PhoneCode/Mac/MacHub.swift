#if os(macOS)
  import AppKit
  import CoreImage.CIFilterBuiltins
  import PhoneCodeCore
  import SwiftUI

  /// The Mac is the hub: phone-code runs here, so the Mac app connects to it
  /// by itself (through the daemon's local control endpoint, no pairing
  /// code), and is where phones get paired. The app carries its own
  /// phonecode (Contents/Helpers/phonecode, see scripts/build-daemon.sh) and
  /// starts it when none is running, so nothing else needs installing.
  @MainActor @Observable
  final class MacHub {
    enum State: Equatable {
      /// Checking for a running daemon.
      case looking
      /// No daemon answers on this Mac.
      case notRunning
      /// We launched `phonecode` and are waiting for it.
      case starting
      /// Found it; pairing this app with it.
      case connecting
      case failed(String)
    }

    private(set) var state: State = .looking
    /// The local daemon while one answers.
    private(set) var daemon: LocalDaemon?
    /// The user chose to connect elsewhere or disconnected: stop auto-connecting.
    var paused = false

    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var launched: Process?
    /// Starts that died within a few seconds, to stop retrying a daemon that cannot run.
    @ObservationIgnored private var quickExits = 0
    @ObservationIgnored private var launchedAt = Date.distantPast
    @ObservationIgnored private var quitObserver: NSObjectProtocol?

    /// Where phone-code keeps its state (`$PHONECODE_HOME` or `~/.phonecode`).
    let stateDir = LocalDaemon.stateDirectory()

    /// The phonecode to run: `$PHONECODE_BIN`, else the app's own, else an
    /// installed one (install.sh's `~/.local/bin`, Homebrew).
    var binary: URL? {
      let env = ProcessInfo.processInfo.environment
      let home = FileManager.default.homeDirectoryForCurrentUser.path
      let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/phonecode").path
      let candidates = [
        env["PHONECODE_BIN"], bundled, "\(home)/.local/bin/phonecode", "/opt/homebrew/bin/phonecode", "/usr/local/bin/phonecode",
      ]
      return candidates.compactMap { $0 }.first { FileManager.default.isExecutableFile(atPath: $0) }.map {
        URL(fileURLWithPath: $0)
      }
    }

    /// Whether the app starts phone-code by itself when none is running.
    /// Off under UI tests, which run their own daemon.
    var autoStart: Bool { ProcessInfo.processInfo.environment["PC_NO_AUTOSTART"] == nil }

    static let installCommand = "curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh | sh"

    /// Watches for the local daemon until the app is connected to it.
    func run(_ model: AppModel) {
      loop?.cancel()
      loop = Task { [weak self, weak model] in
        while !Task.isCancelled {
          guard let self, let model else { return }
          await self.tick(model)
          // Quick while not connected, so a daemon that comes up is noticed at once.
          let settled = model.isPaired && model.client.status == .open
          try? await Task.sleep(for: .seconds(settled ? 10 : 1.5))
        }
      }
    }

    private func tick(_ model: AppModel) async {
      let found = await LocalDaemon.find(in: stateDir)
      daemon = found
      // This Mac's phone-code is down while the app wants it: start the app's own.
      let wantsLocal = !paused && (!model.isPaired || isLocal(model.creds))
      if found == nil, wantsLocal, autoStart, launched?.isRunning != true, binary != nil {
        if quickExits < 3 {
          startDaemon()
        } else if state != .notRunning, !model.isPaired {
          state = .failed("phone-code keeps stopping right after it starts. Its log: \(logPath)")
        }
      }
      // Paired with "this Mac", but this Mac's phone-code now runs elsewhere
      // (another port, another state folder): follow the one that answers.
      if model.isPaired, !paused, isLocal(model.creds), let found,
        model.creds?.baseURL.port != found.control.port
      {
        model.unpair(reason: nil, tellHost: false)
      }
      guard !model.isPaired, !paused else { return }
      guard let found else {
        if case .failed = state { return }
        if state != .starting || launched?.isRunning != true { state = .notRunning }
        return
      }
      state = .connecting
      do {
        let creds = try await found.pairThisApp(deviceName: Device.name, clientId: Device.clientId)
        model.adopt(creds)
        state = .looking
      } catch {
        state = .failed("\(error)")
      }
    }

    /// Connect to the local daemon again (after "Disconnect" or connecting elsewhere).
    func resume(_ model: AppModel) {
      paused = false
      state = .looking
      run(model)
    }

    var logPath: String { stateDir.appendingPathComponent("daemon.log").path }

    /// Starts `phonecode` in the user's login shell (so agents on their PATH
    /// are found), logging to `<state>/daemon.log`. The app stops it when it
    /// quits; closing the window keeps it running, so phones stay connected.
    func startDaemon() {
      guard let bin = binary else { return }
      try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
      let log = logPath
      let p = Process()
      p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
      p.arguments = ["-l", "-c", "exec \"$0\" --no-qr >>\"$1\" 2>&1 </dev/null", bin.path, log]
      var env = ProcessInfo.processInfo.environment
      env["PHONECODE_HOME"] = stateDir.path
      p.environment = env
      p.terminationHandler = { [weak self] proc in
        Task { @MainActor in
          guard let self, self.launched === proc else { return }
          if Date().timeIntervalSince(self.launchedAt) < 10 { self.quickExits += 1 }
        }
      }
      do {
        try p.run()
        launched = p
        launchedAt = Date()
        state = .starting
        quitObserver = quitObserver
          ?? NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
          ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopDaemon() }
          }
      } catch {
        state = .failed("Could not start phonecode: \(error.localizedDescription)")
      }
    }

    /// Stops the phone-code this app started (SIGTERM: it saves its state and exits).
    func stopDaemon() {
      guard let p = launched, p.isRunning else { return }
      p.terminate()
      let deadline = Date().addingTimeInterval(3)
      while p.isRunning, Date() < deadline { usleep(50_000) }
    }

    /// Whether the app is connected to the daemon on this Mac (not another computer).
    func isLocal(_ creds: HostCredentials?) -> Bool {
      guard let host = creds?.baseURL.host?.lowercased() else { return false }
      return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }
  }

  // MARK: - Not connected yet

  /// Shown instead of the phone's pairing screen: phone-code on this Mac is
  /// found and connected automatically; this explains what to do when it isn't running.
  struct MacSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var connectElsewhere = false

    var body: some View {
      let hub = model.hub
      ScrollView {
        VStack(spacing: 22) {
          Image("AppIconImage")
            .resizable()
            .frame(width: 96, height: 96)
            .clipShape(.rect(cornerRadius: 22))
          Text("phone-code on this Mac")
            .font(.largeTitle.bold())
          if let reason = model.pairReason {
            Label(reason, systemImage: "info.circle")
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("pair-reason")
          }
          status(hub)
          Divider().frame(maxWidth: 320)
          Button("Connect to another computer…") {
            hub.paused = true
            connectElsewhere = true
          }
          .buttonStyle(.link)
          .accessibilityIdentifier("connect-elsewhere")
        }
        .padding(40)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
      }
      .background(Color.appBackground)
      .sheet(isPresented: $connectElsewhere, onDismiss: {
        if !model.isPaired { hub.resume(model) }
      }) {
        PairingView()
          .frame(minWidth: 460, minHeight: 520)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { connectElsewhere = false }
            }
          }
      }
      .onChange(of: model.isPaired) { _, paired in
        if paired { connectElsewhere = false }
      }
      .axContainer("mac-setup")
    }

    @ViewBuilder
    private func status(_ hub: MacHub) -> some View {
      switch hub.paused ? .notRunning : hub.state {
      case .looking, .connecting:
        ProgressView(hub.state == .connecting ? "Connecting…" : "Looking for phone-code…")
          .accessibilityIdentifier("mac-setup-looking")
      case .starting:
        ProgressView("Starting phone-code…")
          .accessibilityIdentifier("mac-setup-starting")
      case .failed(let why):
        Label(why, systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
          .multilineTextAlignment(.center)
        Button("Try again") { hub.resume(model) }
          .buttonStyle(.graphitePrimary)
      case .notRunning:
        if hub.paused {
          Button("Connect to phone-code on this Mac") { hub.resume(model) }
            .buttonStyle(.graphitePrimary)
            .controlSize(.large)
            .accessibilityIdentifier("mac-setup-resume")
        } else if hub.binary != nil {
          Text("phone-code is installed but not running.")
            .foregroundStyle(.secondary)
          Button("Start phone-code") { hub.startDaemon() }
            .buttonStyle(.graphitePrimary)
            .controlSize(.large)
            .accessibilityIdentifier("mac-setup-start")
          Text("Or run `phonecode` in a terminal. This window connects as soon as it is up.")
            .font(.callout)
            .foregroundStyle(.secondary)
        } else {
          Text("Install phone-code, then run `phonecode` in a terminal. This window connects as soon as it is up.")
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          CommandBox(command: MacHub.installCommand)
        }
      }
    }
  }

  /// A command with a copy button.
  struct CommandBox: View {
    let command: String
    @State private var copied = false

    var body: some View {
      HStack {
        Text(command)
          .font(.callout.monospaced())
          .textSelection(.enabled)
          .lineLimit(2)
        Spacer(minLength: 8)
        Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
          Clipboard.copy(command)
          copied = true
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
      }
      .padding(12)
      .background(.fill.tertiary, in: .rect(cornerRadius: 10))
    }
  }

  // MARK: - Pair a phone

  /// The QR code a phone scans (and the code to type), from the local daemon.
  struct PairPhoneView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var code: LocalDaemon.PairCode?
    @State private var error: String?
    @State private var publicURL: String?

    var body: some View {
      VStack(spacing: 18) {
        Text("Pair a phone")
          .font(.title.bold())
        Text("Open phone-code on your iPhone and tap **Scan QR code**.")
          .foregroundStyle(.secondary)
        if let code {
          QRCodeView(text: code.pairUrl)
            .frame(width: 240, height: 240)
            .padding(12)
            .background(.white, in: .rect(cornerRadius: 16))
            .accessibilityIdentifier("pair-phone-qr")
          VStack(spacing: 4) {
            Text("Or type this code")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text(code.code)
              .font(.title2.monospaced().bold())
              .textSelection(.enabled)
              .accessibilityIdentifier("pair-phone-code")
            if let exp = code.expires {
              Text("Expires \(exp, style: .relative)")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          if publicURL == nil {
            Label(
              "Your phone can only reach this Mac through Tailscale or a tunnel. Run `phonecode setup` once to set that up.",
              systemImage: "exclamationmark.triangle"
            )
            .font(.callout)
            .foregroundStyle(.orange)
            .multilineTextAlignment(.center)
          }
        } else if let error {
          ContentUnavailableView("Cannot get a pairing code", systemImage: "exclamationmark.triangle", description: Text(error))
        } else {
          ProgressView().frame(width: 240, height: 240)
        }
        HStack {
          Button("New code", systemImage: "arrow.clockwise") { Task { await load() } }
          Spacer()
          Button("Done") { dismiss() }
            .keyboardShortcut(.defaultAction)
        }
      }
      .padding(28)
      .frame(width: 420)
      .task { await load() }
      .axContainer("pair-phone")
    }

    private func load() async {
      guard let d = await LocalDaemon.find(in: model.hub.stateDir) else {
        error = "phone-code is not running on this Mac."
        return
      }
      do {
        publicURL = try await d.status().url
        code = try await d.newPairCode()
        error = nil
      } catch {
        self.error = "\(error)"
      }
    }
  }

  /// Devices paired with phone-code on this Mac, with revoke.
  struct PhonesView: View {
    @Environment(AppModel.self) private var model
    @State private var devices: [LocalDaemon.Device] = []
    @State private var error: String?
    @State private var pairing = false
    @State private var confirm: LocalDaemon.Device?

    var body: some View {
      Form {
        Section {
          ForEach(devices) { d in
            HStack {
              Image(systemName: d.id == model.creds?.deviceId ? "desktopcomputer" : "iphone")
                .frame(width: 22)
              VStack(alignment: .leading) {
                Text(d.name + (d.id == model.creds?.deviceId ? " (this app)" : ""))
                Text("Last seen \(d.lastSeen, style: .relative) ago")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if d.id != model.creds?.deviceId {
                Button("Revoke", role: .destructive) { confirm = d }
                  .accessibilityIdentifier("device-revoke")
              }
            }
            .axContainer("device-row")
          }
        } header: {
          Text("Paired devices")
        } footer: {
          if let error { Text(error).foregroundStyle(.orange) }
        }
        Section {
          Button("Pair a phone…", systemImage: "qrcode") { pairing = true }
            .accessibilityIdentifier("pair-phone")
        }
      }
      .formStyle(.grouped)
      .task { await load() }
      .sheet(isPresented: $pairing, onDismiss: { Task { await load() } }) { PairPhoneView() }
      .confirmationDialog(
        "Revoke \(confirm?.name ?? "")?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
        titleVisibility: .visible
      ) {
        Button("Revoke", role: .destructive) {
          if let d = confirm { Task { await revoke(d) } }
        }
      } message: {
        Text("It is signed out right away, along with any device paired through it.")
      }
    }

    private func load() async {
      guard let d = await LocalDaemon.find(in: model.hub.stateDir) else {
        error = "phone-code is not running on this Mac."
        return
      }
      do {
        devices = try await d.devices().sorted { $0.lastSeenAt > $1.lastSeenAt }
        error = nil
      } catch { self.error = "\(error)" }
    }

    private func revoke(_ device: LocalDaemon.Device) async {
      guard let d = await LocalDaemon.find(in: model.hub.stateDir) else { return }
      do { try await d.revoke(device.id) } catch { self.error = "\(error)" }
      await load()
    }
  }

  /// A crisp QR code for `text`.
  struct QRCodeView: View {
    let text: String

    var body: some View {
      if let img = Self.image(text) {
        Image(nsImage: img)
          .interpolation(.none)
          .resizable()
          .scaledToFit()
          .accessibilityLabel("Pairing QR code")
      }
    }

    static func image(_ text: String) -> NSImage? {
      let f = CIFilter.qrCodeGenerator()
      f.message = Data(text.utf8)
      f.correctionLevel = "M"
      guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
      let rep = NSCIImageRep(ciImage: out)
      let img = NSImage(size: rep.size)
      img.addRepresentation(rep)
      return img
    }
  }
#endif
