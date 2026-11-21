import PhoneCodeCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

extension Color {
  static var appBackground: Color {
    #if os(iOS)
      Color(uiColor: .systemBackground)
    #else
      Color(nsColor: .windowBackgroundColor)
    #endif
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var phase

  var body: some View {
    Group {
      if model.isPaired {
        #if os(macOS)
          MacMainView()
        #else
          PhoneMainView()
        #endif
      } else {
        #if os(macOS)
          MacSetupView()
        #else
          PairingView()
        #endif
      }
    }
    .overlay(alignment: .bottom) { ToastView() }
    .onChange(of: phase) { _, p in
      model.isActive = p == .active
      if p == .active { model.client.probe() }
      #if os(iOS)
        if p == .background { BackgroundGrace.begin() } else if p == .active { BackgroundGrace.end() }
      #endif
    }
  }
}

/// Bottom toast with an optional Undo.
struct ToastView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if let t = model.toast {
      HStack(spacing: 12) {
        Image(systemName: t.symbol)
        Text(t.text).lineLimit(2)
        if let undo = t.undo {
          Button("Undo") {
            undo()
            model.toast = nil
          }
          .fontWeight(.semibold)
          .accessibilityIdentifier("toast-undo")
        }
      }
      .padding(.horizontal, 18)
      .padding(.vertical, 12)
      .glassEffect(.regular, in: .capsule)
      .padding(.bottom, 90)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .axContainer("toast")
    }
  }
}

#if os(iOS)
  /// Keeps the socket alive for the short time iOS allows after leaving the
  /// app, so a turn that finishes right then still produces a notification.
  @MainActor
  enum BackgroundGrace {
    private static var task: UIBackgroundTaskIdentifier = .invalid

    static func begin() {
      guard task == .invalid else { return }
      task = UIApplication.shared.beginBackgroundTask(withName: "phone-code-sync") { end() }
    }

    static func end() {
      guard task != .invalid else { return }
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
  }
#endif

/// Connection banner shown above a chat while the link is down.
struct ConnectionBanner: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    switch model.client.status {
    case .open, .idle, .unauthorized:
      EmptyView()
    case .connecting:
      banner("Connecting to \(model.creds?.hostName ?? "your computer")…", "antenna.radiowaves.left.and.right")
    case .reconnecting:
      banner("Reconnecting…", "arrow.triangle.2.circlepath")
    case .incompatible(let why):
      banner(why, "exclamationmark.triangle")
    }
  }

  private func banner(_ text: String, _ symbol: String) -> some View {
    Button {
      model.client.retryNow()
    } label: {
      Label(text, systemImage: symbol)
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
    .buttonStyle(.plain)
    .glassEffect(.regular.tint(.orange.opacity(0.25)), in: .capsule)
    .padding(.top, 6)
    .accessibilityIdentifier("connection-banner")
  }
}
