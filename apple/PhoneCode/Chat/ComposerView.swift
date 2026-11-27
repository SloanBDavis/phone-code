import PhotosUI
import PhoneCodeCore
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// The composer: pickers as native menus (harness, model, mode, folder),
/// photos, slash-command palette, send and stop.
struct ComposerView: View {
  enum Mode: Equatable {
    case new
    case session(SessionInfo)
  }

  @Environment(AppModel.self) private var model
  let mode: Mode
  @Binding var prefill: String?
  @State private var text = ""
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var attachments: [PreparedImage] = []
  @State private var commands: [SlashCommand] = []
  @State private var showFolders = false
  /// Mac, phone-code on this Mac: the system's folder chooser.
  @State private var chooseLocalFolder = false
  @State private var sending = false
  @FocusState private var focused: Bool

  private var session: SessionInfo? {
    if case .session(let s) = mode { return model.client.session(s.id) ?? s }
    return nil
  }

  private var canSend: Bool {
    !sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
  }

  var body: some View {
    VStack(spacing: 8) {
      if let palette = slashMatches, !palette.isEmpty {
        SlashPalette(groups: palette) { cmd in
          text = "/\(cmd.name) "
        }
      }
      VStack(alignment: .leading, spacing: 10) {
        if !attachments.isEmpty { attachmentStrip }
        HStack(alignment: .bottom, spacing: 10) {
          PhotosPicker(selection: $photoItems, maxSelectionCount: 6, matching: .images) {
            Image(systemName: "plus")
              .font(.body.weight(.semibold))
              .foregroundStyle(.secondary)
              .frame(width: 32, height: 32)
              .background(Theme.chip, in: .circle)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Add photos")
          .accessibilityIdentifier("composer-photos")
          TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...8)
            .textFieldStyle(.plain)
            .focused($focused)
            .padding(.vertical, 8)
            #if os(macOS)
              .onSubmit { send() }
            #endif
            .accessibilityIdentifier("composer-input")
          sendButton
        }
        pickers
      }
      // Concentric corners: 12pt inset in a 26pt rounded box leaves 14, the
      // radius of the 28pt capsule chips and the 32pt round buttons near enough.
      .padding(12)
      .glassEffect(.regular, in: .rect(cornerRadius: 26, style: .continuous))
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
    .padding(.top, 4)
    .onChange(of: photoItems) { _, items in
      Task { await loadPhotos(items) }
    }
    .onChange(of: prefill) { _, p in
      if let p {
        text = p
        prefill = nil
        focused = true
      }
    }
    .task(id: session?.id) { await refreshCommands() }
    // A remembered folder that is gone (deleted, or from another computer) falls back to home.
    .task(id: "\(model.client.status == .open)|\(model.draft.cwd)") {
      if mode == .new, model.client.status == .open { await model.checkDraftFolder() }
    }
    .sheet(isPresented: $showFolders) {
      NavigationStack {
        FolderPicker(start: model.draft.cwd) { path in
          model.pickFolder(path)
          showFolders = false
        }
      }
      #if os(macOS)
        .frame(minWidth: 480, idealWidth: 520, minHeight: 520, idealHeight: 600)
      #endif
      .presentationDetents([.medium, .large])
    }
    #if os(macOS)
      .fileImporter(isPresented: $chooseLocalFolder, allowedContentTypes: [.folder]) { result in
        if case .success(let url) = result { model.pickFolder(url.path) }
      }
      .fileDialogDefaultDirectory(URL(fileURLWithPath: model.draft.cwd, isDirectory: true))
      .fileDialogConfirmationLabel("Use Folder")
    #endif
  }

  private var placeholder: String {
    if let s = session { return "Message \(Agents.shortLabel(s, model.client.host))" }
    let d = model.draft
    let info = Agents.find(model.client.host, d.harness)
    return "Message \(info?.name ?? "the agent")"
  }

  @ViewBuilder
  private var sendButton: some View {
    if let s = session, s.status == .running, !canSend {
      Button {
        model.client.interrupt(s.id)
        Haptics.play(.deny)
      } label: {
        Image(systemName: "stop.fill")
          .font(.footnote.weight(.bold))
          .foregroundStyle(Theme.onInk)
          .frame(width: 32, height: 32)
          .background(Theme.ink, in: .circle)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop")
      .accessibilityIdentifier("composer-stop")
    } else {
      Button {
        send()
      } label: {
        Image(systemName: "arrow.up")
          .font(.subheadline.weight(.bold))
          .foregroundStyle(canSend ? Theme.onInk : Color.secondary)
          .frame(width: 32, height: 32)
          .background(canSend ? Theme.ink : Theme.chip, in: .circle)
          .animation(.easeOut(duration: 0.15), value: canSend)
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .keyboardShortcut(.return, modifiers: .command)
      .accessibilityLabel("Send")
      .accessibilityIdentifier("composer-send")
    }
  }

  // MARK: pickers

  @ViewBuilder
  private var pickers: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        switch mode {
        case .new:
          harnessMenu
          let agent = Agents.find(model.client.host, model.draft.harness)
          let options = Agents.modelOptions(agent)
          modelMenu(
            options: options, current: model.draft.model,
            levels: Agents.efforts(agent, model: model.draft.model),
            effort: model.draft.effort ?? Agents.currentModel(model.draft.model, options)?.defaultEffort,
            pickEffort: { model.pickEffort($0) }
          ) {
            model.pickModel($0)
          }
          modeMenu(modes: Agents.modes(Agents.find(model.client.host, model.draft.harness)), current: model.draft.mode) {
            model.pickMode($0)
          }
          Button {
            #if os(macOS)
              // The computer is this Mac: Finder's chooser, with Recents, favorites and search.
              if model.hub.isLocal(model.creds) {
                chooseLocalFolder = true
                return
              }
            #endif
            showFolders = true
          } label: {
            Label(folderName(model.draft.cwd), systemImage: "folder")
          }
          .buttonStyle(.graphite)
          .accessibilityIdentifier("picker-folder")
        case .session:
          if let s = session {
            let options = Agents.sessionModels(s, model.client.host)
            let levels = Agents.efforts(session: s, model.client.host)
            if !options.isEmpty || !levels.isEmpty {
              modelMenu(
                options: options, current: s.model, levels: levels,
                effort: s.effort ?? Agents.currentModel(s.model, options)?.defaultEffort,
                pickEffort: { model.client.setEffort(s.id, $0) }
              ) { m in
                if let m { model.client.setModel(s.id, m) }
              }
            }
            // Cursor chats (followed from its app) have no modes to switch here.
            if !Agents.modes(s).isEmpty {
              modeMenu(modes: Agents.modes(s), current: s.permissionMode ?? .default) { model.client.setMode(s.id, $0) }
            }
            Label(folderName(s.cwd), systemImage: "folder")
              .font(.callout)
              .foregroundStyle(.secondary)
              .padding(.horizontal, 6)
            if let c = model.client.chat(s.id).context {
              ContextMeter(tokens: c.tokens, window: c.window)
            }
          }
        }
      }
      .controlSize(.small)
    }
  }

  private var harnessMenu: some View {
    let d = model.draft
    let agents = Agents.pickerList(model.client.host)
    let ready = agents.filter(\.available)
    let missing = agents.filter { !$0.available }
    // Installed agents, then the terminal; agents that are not installed sit
    // in a submenu instead of burying the terminal under a dozen dead rows.
    return Menu {
      ForEach(ready) { a in
        Button {
          model.pickHarness(a.id)
          Haptics.play(.select)
        } label: {
          if a.id == d.harness {
            Label(a.name, systemImage: "checkmark")
          } else {
            Text(a.name)
          }
        }
      }
      Divider()
      Button {
        Task { await model.openTerminal() }
      } label: {
        Label("Terminal", systemImage: "apple.terminal")
      }
      .accessibilityIdentifier("picker-terminal")
      if !missing.isEmpty {
        Divider()
        Menu("Not installed") {
          ForEach(missing) { a in
            Button {
              model.pickHarness(a.id)
            } label: {
              Text(a.name)
              Text(a.setupHint ?? "Not installed")
            }
          }
        }
      }
    } label: {
      Text(Agents.find(model.client.host, d.harness)?.name ?? d.harness)
        .graphiteChip()
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .accessibilityIdentifier("picker-harness")
  }

  /// The model, and the thinking level when the model has levels: one chip
  /// ("Opus 4.7 · High"), so the composer's row still fits a phone.
  private func modelMenu(
    options: [ModelOption], current: String?, levels: [EffortOption] = [], effort: String? = nil,
    pickEffort: @escaping (String) -> Void = { _ in }, pick: @escaping (String?) -> Void
  ) -> some View {
    let label = Agents.modelLabel(current, options) ?? "Default model"
    let level = levels.isEmpty ? nil : Agents.effortLabel(effort, levels)
    return Menu {
      Section("Model") {
        if options.isEmpty {
          Text("Its models appear after the first message")
        }
        ForEach(options) { o in
          Button {
            pick(o.isDefault == true ? nil : o.id)
          } label: {
            let selected = Agents.currentModel(current, options)?.id == o.id
            if selected {
              Label(o.name ?? o.id, systemImage: "checkmark")
            } else {
              Text(o.name ?? o.id)
            }
            if let d = o.description { Text(d) }
          }
        }
      }
      if !levels.isEmpty {
        Section("Thinking") {
          ForEach(levels) { l in
            Button {
              pickEffort(l.id)
              Haptics.play(.select)
            } label: {
              if l.id == effort {
                Label(l.label, systemImage: "checkmark")
              } else {
                Text(l.label)
              }
              if let d = l.description { Text(d) }
            }
            .accessibilityIdentifier("effort-\(l.id)")
          }
        }
      }
    } label: {
      Label(level.map { "\(label) · \($0)" } ?? label, systemImage: "cpu")
        .graphiteChip()
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .accessibilityIdentifier("picker-model")
  }

  private func modeMenu(modes: [PermissionMode], current: PermissionMode, pick: @escaping (PermissionMode) -> Void) -> some View {
    Menu {
      ForEach(modes) { m in
        Button(role: m == .bypassPermissions ? .destructive : nil) {
          pick(m)
          Haptics.play(.select)
        } label: {
          Label(m.label, systemImage: m == current ? "checkmark" : m.symbol)
          Text(m.hint)
        }
      }
    } label: {
      Label(current.shortLabel, systemImage: current.symbol)
        .graphiteChip()
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .accessibilityIdentifier("picker-mode")
  }

  private func folderName(_ path: String) -> String {
    let t = tildePath(path, home: model.client.host?.home)
    return t == "~" ? "~" : (t.split(separator: "/").last.map(String.init) ?? t)
  }

  // MARK: attachments

  private var attachmentStrip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(attachments) { a in
          ZStack(alignment: .topTrailing) {
            Image(platformImage: a.preview)
              .resizable()
              .scaledToFill()
              .frame(width: 64, height: 64)
              .clipShape(.rect(cornerRadius: 12))
            Button {
              attachments.removeAll { $0.id == a.id }
            } label: {
              Image(systemName: "xmark.circle.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .black.opacity(0.6))
            }
            .buttonStyle(.plain)
            .padding(3)
            .accessibilityLabel("Remove photo")
          }
        }
      }
    }
  }

  private func loadPhotos(_ items: [PhotosPickerItem]) async {
    guard !items.isEmpty else { return }
    for item in items {
      if let data = try? await item.loadTransferable(type: Data.self), let p = PreparedImage.make(from: data) {
        attachments.append(p)
      }
    }
    photoItems = []
  }

  // MARK: slash commands

  private var slashMatches: [SlashCommands.Group]? {
    guard text.hasPrefix("/"), !text.contains(" "), !text.contains("\n") else { return nil }
    let list = commands.isEmpty ? (Agents.find(model.client.host, model.draft.harness)?.commands ?? []) : commands
    return SlashCommands.group(list, typed: String(text.dropFirst()))
  }

  private func refreshCommands() async {
    guard let s = session else {
      commands = []
      return
    }
    if let list = try? await model.client.commands(s.id) { commands = list }
  }

  // MARK: send

  private func send() {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    let images = attachments.map(\.attachment)
    text = ""
    attachments = []
    Haptics.play(.send)
    switch mode {
    case .new:
      sending = true
      Task {
        _ = await model.startChat(text: body, attachments: images)
        sending = false
      }
    case .session(let s):
      Task { await model.client.sendChat(s.id, text: body, attachments: images) }
    }
  }
}

/// The slash-command palette above the composer, grouped by source.
struct SlashPalette: View {
  let groups: [SlashCommands.Group]
  var pick: (SlashCommand) -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(groups) { g in
          Text(g.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
          ForEach(g.items) { c in
            Button {
              pick(c)
            } label: {
              HStack(alignment: .firstTextBaseline) {
                Text("/\(c.name)").font(.body.monospaced())
                if let h = c.argumentHint { Text(h).font(.caption.monospaced()).foregroundStyle(.secondary) }
                Spacer()
                if let d = c.description {
                  Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
              }
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("slash-command")
          }
        }
      }
      .padding(12)
    }
    .frame(maxHeight: 240)
    .glassEffect(.regular, in: .rect(cornerRadius: 20))
    .axContainer("slash-palette")
  }
}

/// A photo ready to send: downscaled, JPEG or PNG, base64.
struct PreparedImage: Identifiable {
  let id = UUID()
  let preview: PlatformImage
  let attachment: PhoneCodeCore.Attachment

  static func make(from data: Data, maxSide: CGFloat = 2048) -> PreparedImage? {
    #if os(iOS)
      guard let img = UIImage(data: data) else { return nil }
      let scale = min(1, maxSide / max(img.size.width, img.size.height))
      var out = img
      if scale < 1 {
        let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
        out = UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
      }
      guard let jpeg = out.jpegData(compressionQuality: 0.85) else { return nil }
      return PreparedImage(preview: out, attachment: .init(mediaType: "image/jpeg", name: "photo.jpg", data: jpeg.base64EncodedString()))
    #else
      guard let img = NSImage(data: data), let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
      guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { return nil }
      return PreparedImage(preview: img, attachment: .init(mediaType: "image/jpeg", name: "photo.jpg", data: jpeg.base64EncodedString()))
    #endif
  }
}

/// How full the model's context is: a small ring and a percentage beside the
/// composer's pickers, with the token counts on hover.
struct ContextMeter: View {
  let tokens: Double
  let window: Double

  private var fraction: Double { min(1, max(0, tokens / window)) }

  private var tint: Color {
    fraction >= 0.9 ? .red : fraction >= 0.75 ? .orange : .secondary
  }

  private static func short(_ n: Double) -> String {
    n >= 1_000_000 ? String(format: "%.1fM", n / 1_000_000) : n >= 1000 ? String(format: "%.0fk", n / 1000) : String(Int(n))
  }

  var body: some View {
    HStack(spacing: 5) {
      ZStack {
        Circle().stroke(Theme.chip, lineWidth: 2.5)
        Circle()
          .trim(from: 0, to: max(0.02, fraction))
          .stroke(tint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
      .frame(width: 13, height: 13)
      Text("\(Int((fraction * 100).rounded()))%")
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 6)
    .help("\(Self.short(tokens)) of \(Self.short(window)) tokens of context used")
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Context \(Int((fraction * 100).rounded())) percent used")
    .accessibilityIdentifier("context-meter")
  }
}
