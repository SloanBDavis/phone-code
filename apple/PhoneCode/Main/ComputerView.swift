import PhoneCodeCore
import SwiftUI

/// "This computer": the connection, which harnesses are ready (with setup
/// hints), this device, notifications, and unpairing.
struct ComputerView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var confirmUnpair = false

  var body: some View {
    @Bindable var model = model
    let host = model.client.host
    Form {
      Section("Connection") {
        LabeledContent("Computer", value: host?.name ?? model.creds?.hostName ?? "—")
        LabeledContent("Address", value: model.creds?.baseURL.absoluteString ?? "—")
        LabeledContent("Status") {
          HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 8, height: 8)
            Text(statusText)
          }
        }
        .accessibilityIdentifier("computer-status")
        if let c = host?.connection {
          LabeledContent("Route", value: Self.routeName(c.mode))
          if !c.secure {
            Label("Not encrypted. Use Tailscale or your own https URL.", systemImage: "lock.open")
              .foregroundStyle(.orange)
          }
        }
        if let v = host?.daemonVersion { LabeledContent("phone-code", value: v) }
        if let h = host { LabeledContent("User", value: "\(h.user) · \(h.platform)") }
      }
      if let cursor = host?.cursor, cursor.installed {
        Section {
          CursorToggle(status: cursor)
        } header: {
          Text("Cursor")
        } footer: {
          Text("Your Cursor app chats show up here as you work: what you asked, its thinking, commands, edits and answers. When Cursor finishes a turn, reply here and it continues that chat. phone-code adds a hook to Cursor (~/.cursor/hooks.json) and keeps your other hooks.")
        }
      }
      Section("Coding agents") {
        ForEach(Agents.pickerList(host)) { a in
          HStack(alignment: .top, spacing: 12) {
            HarnessGlyph(id: a.id, size: 28)
            VStack(alignment: .leading, spacing: 2) {
              HStack {
                Text(a.name)
                if let v = a.version { Text(v).font(.caption).foregroundStyle(.secondary) }
              }
              if let hint = a.setupHint {
                Text(hint).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
              }
            }
            Spacer()
            Image(systemName: a.available && a.setupHint == nil ? "checkmark.circle.fill" : "exclamationmark.circle")
              .foregroundStyle(a.available && a.setupHint == nil ? Color.green : Color.orange)
          }
          .axContainer("computer-agent")
        }
      }
      Section {
        Toggle("Notify me", isOn: $model.notificationsEnabled)
          .accessibilityIdentifier("notifications-toggle")
      } header: {
        Text("Notifications")
      } footer: {
        Text("While the app is open or was just closed, phone-code tells you when a chat needs you or finishes. Notifications when the app is closed need Apple push, which phone-code does not support yet.")
      }
      Section("This device") {
        LabeledContent("Name", value: Device.name)
        LabeledContent("Device ID", value: model.client.deviceId ?? model.creds?.deviceId ?? "—")
          .textSelection(.enabled)
        #if os(macOS)
          Button("Disconnect", role: .destructive) { confirmUnpair = true }
            .accessibilityIdentifier("unpair")
        #else
          Button("Unpair this device", role: .destructive) { confirmUnpair = true }
            .accessibilityIdentifier("unpair")
        #endif
      }
    }
    .formStyle(.grouped)
    .navigationTitle("This computer")
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    #endif
    .confirmationDialog("Unpair this device?", isPresented: $confirmUnpair, titleVisibility: .visible) {
      Button("Unpair", role: .destructive) {
        dismiss()
        model.unpair()
      }
    } message: {
      Text("Your computer forgets this device. Pair again by scanning its QR code.")
    }
    .axContainer("computer-sheet")
  }

  private var statusText: String {
    switch model.client.status {
    case .open: "Connected"
    case .connecting: "Connecting…"
    case .reconnecting: "Reconnecting…"
    case .idle: "Not connected"
    case .unauthorized(let m), .incompatible(let m): m
    }
  }

  private var statusColor: Color {
    switch model.client.status {
    case .open: .green
    case .connecting, .reconnecting: .orange
    default: .red
    }
  }

  static func routeName(_ mode: String) -> String {
    switch mode {
    case "tailscale": "Tailscale (private to your devices)"
    case "tunnel": "Cloudflare tunnel"
    case "url": "Your https address"
    case "lan": "Local network (http)"
    case "local": "This computer only"
    default: mode
    }
  }
}

/// Connects Cursor's app (installs phone-code's hooks) or disconnects it.
struct CursorToggle: View {
  @Environment(AppModel.self) private var model
  let status: CursorStatus
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Toggle(
        "Follow Cursor chats",
        isOn: Binding(get: { status.connected }, set: { on in set(on) })
      )
      .disabled(busy)
      .accessibilityIdentifier("cursor-toggle")
      if let error {
        Text(error).font(.footnote).foregroundStyle(Theme.danger)
      }
    }
  }

  private func set(_ on: Bool) {
    busy = true
    Task {
      do {
        try await model.client.setCursorConnected(on)
        error = nil
      } catch {
        self.error = "\(error)"
      }
      busy = false
    }
  }
}

#if os(macOS)
  struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
      @Bindable var model = model
      TabView {
        Tab("Computer", systemImage: "desktopcomputer") {
          if model.isPaired {
            ComputerView()
          } else {
            ContentUnavailableView("Not connected", systemImage: "link", description: Text("Start phone-code from the main window."))
          }
        }
        if model.hub.isLocal(model.creds) {
          Tab("Phones", systemImage: "iphone") {
            PhonesView()
          }
        }
        Tab("Terminal", systemImage: "apple.terminal") {
          Form {
            Slider(value: $model.termFontSize, in: 9...24, step: 1) {
              Text("Font size: \(Int(model.termFontSize)) pt")
            }
          }
          .formStyle(.grouped)
        }
      }
    }
  }
#endif

/// Pick the folder a new chat runs in: recent folders, then browse with `fs.list`.
struct FolderPicker: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let start: String
  var pick: (String) -> Void
  @State private var path: String?
  @State private var listing: FsListResult?
  @State private var error: String?
  @State private var showHidden = false

  var body: some View {
    List {
      if path == nil, !model.prefs.recentDirs.isEmpty {
        Section("Recent") {
          ForEach(model.prefs.recentDirs, id: \.self) { d in
            Button {
              pick(d)
            } label: {
              Label(tildePath(d, home: model.client.host?.home), systemImage: "clock")
            }
          }
        }
      }
      Section(listing.map { tildePath($0.path, home: model.client.host?.home) } ?? "…") {
        if let parent = listing?.parent {
          Button {
            path = parent
          } label: {
            Label("..", systemImage: "arrow.turn.left.up")
          }
        }
        ForEach((listing?.entries ?? []).filter { $0.dir && (showHidden || !$0.hidden) }) { e in
          Button {
            if let l = listing { path = (l.path as NSString).appendingPathComponent(e.name) }
          } label: {
            Label(e.name, systemImage: "folder")
          }
          .accessibilityIdentifier("folder-entry")
        }
      }
    }
    .overlay {
      if let error { ContentUnavailableView("Cannot open folder", systemImage: "folder.badge.questionmark", description: Text(error)) }
    }
    .navigationTitle("Folder")
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Use this folder") {
          if let p = listing?.path { pick(p) }
        }
        .disabled(listing == nil)
        .accessibilityIdentifier("folder-use")
      }
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }
      }
      ToolbarItem(placement: .automatic) {
        Toggle("Hidden", isOn: $showHidden)
      }
    }
    .task(id: path ?? start) {
      do {
        listing = try await model.client.listFolder(path ?? start)
        error = nil
      } catch let failure {
        // The start folder is gone: begin at home rather than at an error.
        if path == nil, let home = try? await model.client.listFolder(nil) {
          listing = home
          self.error = nil
        } else {
          self.error = "\(failure)"
        }
      }
    }
  }
}
