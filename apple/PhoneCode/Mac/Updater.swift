#if os(macOS)
  import AppKit
  import SwiftUI

  /// Updating the Mac app from inside it. The latest version is read from
  /// where GitHub sends `/releases/latest`; installing is install.sh (the
  /// script a first install runs) with `--app`: it downloads the new app,
  /// checks it, waits for this one to quit, swaps the bundle and opens it.
  ///
  /// Only a copy installed from a release updates itself (one in an
  /// Applications folder); a build from Xcode says where the new version is.
  @MainActor @Observable
  final class Updater {
    static let shared = Updater()

    enum State: Equatable {
      case idle
      case checking
      case upToDate
      case available(String)
      case installing(String)
      case failed(String)
    }

    private(set) var state: State = .idle
    /// What the alert shows: a newer version, "up to date" after a check the user asked for, or an error.
    var alert: Alert?

    enum Alert: Equatable {
      case available(String)
      case upToDate
      case failed(String)
    }

    static let latestURL = URL(string: "https://github.com/SloanBDavis/phone-code/releases/latest")!
    static let scriptURL = URL(string: "https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh")!

    var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }

    /// Installed from a release: in /Applications or ~/Applications.
    var selfUpdating: Bool {
      Bundle.main.bundleURL.deletingLastPathComponent().lastPathComponent == "Applications"
    }

    /// `1.2.3` as numbers; nil for anything else.
    static func parse(_ v: String) -> [Int]? {
      let parts = v.trimmingCharacters(in: .whitespaces).drop { $0 == "v" }.split(separator: ".", omittingEmptySubsequences: false)
      let nums = parts.compactMap { Int($0) }
      return parts.count == 3 && nums.count == 3 ? nums : nil
    }

    static func isNewer(_ candidate: String, than current: String) -> Bool {
      guard let a = parse(candidate), let b = parse(current) else { return false }
      for i in 0..<3 where a[i] != b[i] { return a[i] > b[i] }
      return false
    }

    /// The latest release's version, without the `v`.
    private func latest() async -> String? {
      var req = URLRequest(url: Self.latestURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
      req.httpMethod = "HEAD"
      guard let (_, response) = try? await URLSession.shared.data(for: req) else { return nil }
      // URLSession follows the redirect: the final address ends in /releases/tag/vX.Y.Z.
      guard let url = response.url, url.pathComponents.suffix(2).first == "tag" else { return nil }
      let version = String(url.lastPathComponent.drop { $0 == "v" })
      return Self.parse(version) == nil ? nil : version
    }

    /// At launch (quiet unless there is something newer) and from the menu (always answers).
    func check(userAsked: Bool) async {
      if case .installing = state { return }
      if case .checking = state { return }
      // A build from Xcode is not replaced under the developer, so it does not ask at launch either.
      if !userAsked, !selfUpdating || ProcessInfo.processInfo.environment["PC_NO_AUTOSTART"] != nil { return }
      state = .checking
      guard let version = await latest() else {
        state = .failed("Could not reach GitHub to look for a newer version.")
        if userAsked { alert = .failed("Could not reach GitHub to look for a newer version.") }
        return
      }
      if Self.isNewer(version, than: current) {
        state = .available(version)
        alert = .available(version)
      } else {
        state = .upToDate
        if userAsked { alert = .upToDate }
      }
    }

    /// Downloads `version`, then quits so the installer can swap the app and open the new one.
    func install(_ version: String) {
      guard selfUpdating else {
        NSWorkspace.shared.open(URL(string: "https://github.com/SloanBDavis/phone-code/releases/tag/v\(version)")!)
        return
      }
      state = .installing(version)
      Task {
        do {
          try await runInstaller(version)
          NSApp.terminate(nil)
        } catch {
          let message = "The update did not install: \(error.localizedDescription)"
          state = .failed(message)
          alert = .failed(message)
        }
      }
    }

    private struct InstallError: LocalizedError {
      let errorDescription: String?
    }

    private func runInstaller(_ version: String) async throws {
      let (script, response) = try await URLSession.shared.data(from: Self.scriptURL)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw InstallError(errorDescription: "could not download the installer.")
      }
      let fm = FileManager.default
      let work = fm.temporaryDirectory.appendingPathComponent("phonecode-update-\(UUID().uuidString.prefix(8))")
      try fm.createDirectory(at: work, withIntermediateDirectories: true)
      let scriptFile = work.appendingPathComponent("install.sh")
      let ready = work.appendingPathComponent("ready")
      let log = work.appendingPathComponent("update.log")
      try script.write(to: scriptFile)
      fm.createFile(atPath: log.path, contents: nil)

      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/sh")
      p.arguments = [scriptFile.path, "--app"]
      var env = ProcessInfo.processInfo.environment
      env["PHONECODE_APP_DIR"] = Bundle.main.bundleURL.deletingLastPathComponent().path
      env["PHONECODE_VERSION"] = "v\(version)"
      env["PHONECODE_WAIT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
      env["PHONECODE_READY_FILE"] = ready.path
      env["PHONECODE_OPEN_APP"] = "1"
      env["PHONECODE_QUIET"] = "1"
      p.environment = env
      // A file, not a pipe: the installer outlives this app and must not lose its output's reader.
      let out = try FileHandle(forWritingTo: log)
      p.standardOutput = out
      p.standardError = out
      p.standardInput = FileHandle.nullDevice
      try p.run()

      // The installer writes `ready` once the new app is downloaded and checked; it then waits for us to quit.
      let deadline = Date().addingTimeInterval(10 * 60)
      while !fm.fileExists(atPath: ready.path) {
        if !p.isRunning {
          let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
          let last = text.split(separator: "\n").last.map(String.init) ?? "the installer stopped."
          throw InstallError(errorDescription: last)
        }
        if Date() > deadline {
          p.terminate()
          throw InstallError(errorDescription: "the download took too long.")
        }
        try await Task.sleep(for: .milliseconds(200))
      }
    }
  }

  /// The alerts for updates, on the main window.
  struct UpdatePrompt: ViewModifier {
    @State private var updater = Updater.shared

    func body(content: Content) -> some View {
      let shown = Binding(get: { updater.alert != nil }, set: { if !$0 { updater.alert = nil } })
      content
        .task { await updater.check(userAsked: false) }
        .alert(title, isPresented: shown, presenting: updater.alert) { alert in
          switch alert {
          case .available(let version):
            Button(updater.selfUpdating ? "Update and Restart" : "Show Release") { updater.install(version) }
              .keyboardShortcut(.defaultAction)
            Button("Later", role: .cancel) {}
          case .upToDate, .failed:
            Button("OK", role: .cancel) {}
          }
        } message: { alert in
          switch alert {
          case .available(let version):
            Text(
              updater.selfUpdating
                ? "You have \(updater.current). The app downloads \(version), quits and opens again; your chats keep running on the computer."
                : "You have \(updater.current). This copy was built from source, so it does not replace itself.")
          case .upToDate:
            Text("PhoneCode \(updater.current) is the latest version.")
          case .failed(let message):
            Text(message)
          }
        }
    }

    private var title: String {
      switch updater.alert {
      case .available(let version): "PhoneCode \(version) is available"
      case .upToDate: "You're up to date"
      case .failed: "Update"
      case nil: ""
      }
    }
  }

  /// Settings > Updates: the version, and a button to look for a newer one.
  struct UpdatesView: View {
    @State private var updater = Updater.shared

    var body: some View {
      Form {
        Section {
          LabeledContent("Version", value: updater.current)
          LabeledContent("Status") { Text(status) }
            .accessibilityIdentifier("update-status")
          switch updater.state {
          case .available(let version):
            Button(updater.selfUpdating ? "Update to \(version) and Restart" : "Show Release \(version)") {
              updater.install(version)
            }
          case .installing:
            ProgressView().controlSize(.small)
          default:
            Button("Check for Updates") { Task { await updater.check(userAsked: true) } }
              .disabled(updater.state == .checking)
          }
        } footer: {
          Text("PhoneCode looks for a newer version when it opens. Updating downloads it from GitHub, quits and opens the new one; the phonecode inside the app is updated with it.")
        }
      }
      .formStyle(.grouped)
    }

    private var status: String {
      switch updater.state {
      case .idle: "Not checked yet"
      case .checking: "Checking…"
      case .upToDate: "Up to date"
      case .available(let version): "\(version) is available"
      case .installing(let version): "Downloading \(version)…"
      case .failed(let message): message
      }
    }
  }
#endif
