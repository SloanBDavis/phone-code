#if os(macOS)
  import AppKit
  import PhoneCodeCore
  import SwiftUI
  import WebKit

  /// The Mac app's window: the web app phone-code serves, in a web view.
  ///
  /// One interface for the phone and the Mac. The native side stays small: it
  /// starts phone-code (MacHub), pairs with it and hands the web app that
  /// pairing (so there is no code to type), opens links and file pickers, and
  /// keeps the menu, notifications and updates.
  struct MacShellView: View {
    @Environment(AppModel.self) private var model
    @State private var pairingPhone = false

    var body: some View {
      Group {
        if let creds = model.creds {
          WebShell(creds: creds, canPair: model.hub.isLocal(creds))
            // Another computer or a new pairing: a fresh page with that pairing.
            .id("\(creds.baseURL.absoluteString)|\(creds.token)")
        }
      }
      .ignoresSafeArea()
      // The window has no title bar: this strip at the top moves it, and the
      // page leaves it empty (html.mac-app in the web app's styles).
      // Pinned to the window's top edge: left to the safe area it would sit below the
      // (hidden) title bar instead, over the page's top buttons, and take their clicks.
      .overlay(alignment: .top) {
        WindowDragStrip().frame(height: WebShell.dragStripHeight).ignoresSafeArea()
      }
      .overlay { UpdateProgress() }
      .sheet(isPresented: $pairingPhone) { PairPhoneView() }
      .onReceive(NotificationCenter.default.publisher(for: .pairPhone)) { _ in pairingPhone = true }
    }
  }

  extension Notification.Name {
    /// The menu's "Pair a Phone…".
    static let pairPhone = Notification.Name("pc.pairPhone")
    /// The menu's "Reload".
    static let shellReload = Notification.Name("pc.shellReload")
    /// A menu item for one of the page's commands; the object is its name ("rename").
    static let shellCommand = Notification.Name("pc.shellCommand")
  }

  struct WebShell: NSViewRepresentable {
    let creds: HostCredentials
    /// phone-code runs on this Mac: the page gets a "Pair a phone" button that asks the app for its QR code.
    var canPair = false

    static let dragStripHeight: CGFloat = 28

    func makeCoordinator() -> Coordinator { Coordinator(base: creds.baseURL) }

    func makeNSView(context: Context) -> WKWebView {
      let config = WKWebViewConfiguration()
      config.websiteDataStore = .default()
      config.userContentController.addUserScript(
        WKUserScript(source: Self.bootScript(creds), injectionTime: .atDocumentStart, forMainFrameOnly: true))
      // What the page asks the app for (packages/web/src/lib/shell.ts): only main-frame pages
      // of this app's own phone-code reach it (the coordinator checks).
      if canPair { config.userContentController.add(context.coordinator, name: Coordinator.handlerName) }
      let web = WKWebView(frame: .zero, configuration: config)
      web.navigationDelegate = context.coordinator
      web.uiDelegate = context.coordinator
      web.allowsBackForwardNavigationGestures = false
      web.allowsMagnification = false
      web.underPageBackgroundColor = .windowBackgroundColor
      web.isInspectable = true
      web.setAccessibilityIdentifier("web-shell")
      context.coordinator.attach(web)
      // The page is served by the phone-code this app runs: nothing of it is worth keeping
      // from last time. A cached copy (the web app's own offline cache, made for phones)
      // would show the previous version's interface after an update. What the page stores
      // for itself (its pairing, drafts, layout) is kept.
      let stale: Set<String> = [
        WKWebsiteDataTypeServiceWorkerRegistrations, WKWebsiteDataTypeFetchCache, WKWebsiteDataTypeDiskCache,
        WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeOfflineWebApplicationCache,
      ]
      let url = creds.baseURL
      config.websiteDataStore.removeData(ofTypes: stale, modifiedSince: .distantPast) { [weak web] in
        web?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
      }
      return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {}

    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
      web.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.handlerName)
      coordinator.detach()
    }

    /// Runs before the page's own code: the pairing this app already has
    /// becomes the web app's (its `pc.creds`), and the page learns it is
    /// inside the Mac app (`html.mac-app`).
    static func bootScript(_ creds: HostCredentials) -> String {
      let payload: [String: Any] = [
        "token": creds.token,
        "deviceId": creds.deviceId,
        "pairedAt": creds.pairedAt,
        "host": ["name": creds.hostName, "platform": "darwin", "user": NSUserName()],
      ]
      let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("null".utf8)
      let json = String(data: data, encoding: .utf8) ?? "null"
      return """
        (function () {
          try {
            var want = \(json);
            var have = null;
            try { have = JSON.parse(localStorage.getItem('pc.creds') || 'null'); } catch (e) {}
            if (want && (!have || have.token !== want.token)) localStorage.setItem('pc.creds', JSON.stringify(want));
          } catch (e) {}
          window.__phonecodeShell = 'mac';
          var mark = function () { document.documentElement.classList.add('mac-app'); };
          if (document.documentElement) mark();
          else new MutationObserver(function (_, o) {
            if (!document.documentElement) return;
            mark();
            o.disconnect();
          }).observe(document, { childList: true });
        })();
        """
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
      static let handlerName = "phonecode"
      private let base: URL
      private weak var web: WKWebView?
      private var observers: [NSObjectProtocol] = []
      private var retry: Task<Void, Never>?

      init(base: URL) { self.base = base }

      func attach(_ web: WKWebView) {
        self.web = web
        let center = NotificationCenter.default
        observers.append(
          center.addObserver(forName: .shellReload, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
          })
        observers.append(
          center.addObserver(forName: .shellCommand, object: nil, queue: .main) { [weak self] note in
            guard let name = note.object as? String, name.allSatisfy({ $0.isLetter }) else { return }
            // A page from an older phone-code has no commands: New Chat still goes to its new-chat screen.
            let fallback = name == "newChat" ? "location.hash = '#/';" : ""
            MainActor.assumeIsolated {
              self?.run("if (window.phonecodeCommand) window.phonecodeCommand('\(name)'); else { \(fallback) }")
            }
          })
      }

      func detach() {
        retry?.cancel()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
      }

      private func run(_ js: String) {
        web?.evaluateJavaScript(js, completionHandler: nil)
      }

      private func reload() {
        guard let web else { return }
        if web.url == nil { web.load(URLRequest(url: base)) } else { web.reload() }
      }

      /// phone-code may still be starting, or was restarted: try again shortly.
      private func retrySoon() {
        retry?.cancel()
        retry = Task { [weak self] in
          try? await Task.sleep(for: .seconds(1))
          guard !Task.isCancelled, let self else { return }
          self.web?.load(URLRequest(url: self.base))
        }
      }

      private func isOurs(_ url: URL) -> Bool {
        url.scheme == base.scheme && url.host == base.host && url.port == base.port
      }

      // MARK: navigation

      func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        // The app's own pages stay here; anything else is the browser's.
        if isOurs(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
        if action.targetFrame?.isMainFrame != false { NSWorkspace.shared.open(url) }
        return .cancel
      }

      func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retrySoon()
      }

      func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retrySoon()
      }

      func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
      }

      // MARK: what the page asks the app for

      /// `webkit.messageHandlers.phonecode.postMessage({ type: 'pairPhone' })`: the QR code sheet.
      func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == base.scheme, origin.host == base.host,
          origin.port == (base.port ?? 0)
        else { return }
        guard let body = message.body as? [String: Any], body["type"] as? String == "pairPhone" else { return }
        NotificationCenter.default.post(name: .pairPhone, object: nil)
      }

      /// A link that opens a new window (target="_blank"): the browser's.
      func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
      ) -> WKWebView? {
        if let url = action.request.url {
          if isOurs(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
      }

      /// `<input type="file">`: the system's open panel.
      func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo
      ) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        let response = await panel.begin()
        return response == .OK ? panel.urls : nil
      }

      func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
      }

      func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo
      ) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
      }
    }
  }

  /// The top of the window, where a title bar would be: drag it to move the
  /// window, double-click to zoom. The web view under it would otherwise take
  /// every click.
  struct WindowDragStrip: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Strip() }
    func updateNSView(_ view: NSView, context: Context) {}

    final class Strip: NSView {
      override var mouseDownCanMoveWindow: Bool { true }

      override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
          window?.zoom(nil)
        } else {
          window?.performDrag(with: event)
        }
      }
    }
  }
#endif
