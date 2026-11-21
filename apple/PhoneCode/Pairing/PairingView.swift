import PhoneCodeCore
import SwiftUI

/// Pair with a computer: scan the QR code `phonecode` prints, paste its link,
/// or type the computer's address and the code.
struct PairingView: View {
  @Environment(AppModel.self) private var model
  @State private var address = ""
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?
  @State private var scanning = false
  @FocusState private var focus: Field?

  enum Field { case address, code }

  var body: some View {
    ScrollView {
      VStack(spacing: 28) {
        header
        if let reason = model.pairReason {
          Label(reason, systemImage: "info.circle")
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("pair-reason")
        }
        actions
        form
        if let error {
          Label(error, systemImage: "exclamationmark.triangle.fill")
            .font(.callout)
            .foregroundStyle(.orange)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("pair-error")
        }
        Text("phone-code runs on your computer. Start it with `phonecode` in a terminal, then scan the QR code it shows.")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .padding(.top, 8)
      }
      .padding(24)
      .frame(maxWidth: 460)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Color.appBackground)
    #if os(iOS)
      .fullScreenCover(isPresented: $scanning) {
        QRScannerSheet { text in
          scanning = false
          accept(text)
        }
      }
    #endif
    .task(id: model.pendingLink) {
      guard let link = model.pendingLink else { return }
      if let o = link.origin { address = o.absoluteString }
      code = link.code
      if link.origin != nil { await submit() }
    }
  }

  private var header: some View {
    VStack(spacing: 14) {
      Image("AppIconImage")
        .resizable()
        .frame(width: 88, height: 88)
        .clipShape(.rect(cornerRadius: 20))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
        .accessibilityHidden(true)
      Text("phone-code")
        .font(.largeTitle.bold())
      Text("Your coding agents, in your pocket.")
        .font(.title3)
        .foregroundStyle(.secondary)
    }
    .padding(.top, 32)
  }

  private var actions: some View {
    VStack(spacing: 12) {
      #if os(iOS)
        if QRScannerSheet.isAvailable {
          Button {
            scanning = true
          } label: {
            Label("Scan QR code", systemImage: "qrcode.viewfinder")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
          .accessibilityIdentifier("pair-scan")
        }
      #endif
      Button {
        if let s = Clipboard.string { accept(s) } else { error = "The clipboard is empty." }
      } label: {
        Label("Paste pairing link", systemImage: "doc.on.clipboard")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glass)
      .controlSize(.large)
      .accessibilityIdentifier("pair-paste")
    }
  }

  private var form: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Or type it in")
        .font(.headline)
      TextField("Computer address, e.g. mac.tailnet.ts.net", text: $address)
        .autocorrectionDisabled()
        #if os(iOS)
          .textContentType(.URL)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
        #endif
        .focused($focus, equals: .address)
        .submitLabel(.next)
        .onSubmit { focus = .code }
        .padding(12)
        .background(.fill.tertiary, in: .rect(cornerRadius: 12))
        .accessibilityIdentifier("pair-address")
      TextField("Pairing code, e.g. K7QM-3XPA-9D", text: $code)
        .autocorrectionDisabled()
        #if os(iOS)
          .textInputAutocapitalization(.characters)
        #endif
        .focused($focus, equals: .code)
        .submitLabel(.go)
        .onSubmit { Task { await submit() } }
        .padding(12)
        .background(.fill.tertiary, in: .rect(cornerRadius: 12))
        .accessibilityIdentifier("pair-code")
      Button {
        Task { await submit() }
      } label: {
        HStack {
          if busy { ProgressView().controlSize(.small) }
          Text(busy ? "Pairing…" : "Pair")
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glassProminent)
      .controlSize(.large)
      .disabled(busy || code.trimmingCharacters(in: .whitespaces).isEmpty || address.trimmingCharacters(in: .whitespaces).isEmpty)
      .accessibilityIdentifier("pair-submit")
    }
  }

  /// A scanned or pasted link: fill both fields and pair right away when it has the address.
  private func accept(_ text: String) {
    guard let link = PairingLink.parse(text) else {
      error = "That is not a phone-code pairing link or code."
      return
    }
    if let o = link.origin { address = o.absoluteString }
    code = link.code
    if link.origin != nil { Task { await submit() } } else { focus = .address }
  }

  private func submit() async {
    guard !busy else { return }
    guard let origin = PairingLink.originURL(address) else {
      error = "Enter your computer's address."
      return
    }
    guard let link = PairingLink.parse(code) else {
      error = "Enter the pairing code your computer shows."
      return
    }
    busy = true
    error = nil
    defer { busy = false }
    do {
      try await model.pair(link, origin: origin)
      Haptics.play(.allow)
    } catch let e as PairingError {
      error = e.message
    } catch {
      self.error = "\(error)"
    }
  }
}
