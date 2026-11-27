import XCTest

/// Drives the app against a real phone-code daemon with the scripted fake
/// agents (CI starts it: see .github/workflows/apple.yml). Every main screen is
/// captured as a screenshot attachment that the workflow exports.
///
/// Environment (passed by xcodebuild as TEST_RUNNER_PC_UITEST_*):
///   PC_UITEST_DAEMON  the daemon's URL, e.g. http://127.0.0.1:7777
///   PC_UITEST_CODE    a reusable pairing code (PHONECODE_PAIR_CODE)
@MainActor
final class PhoneCodeUITests: XCTestCase {
  private var app: XCUIApplication!

  private var env: [String: String] { ProcessInfo.processInfo.environment }
  private var daemon: String { env["PC_UITEST_DAEMON"] ?? "http://127.0.0.1:7777" }
  private var code: String { env["PC_UITEST_CODE"] ?? "UITEST-PAIR-01" }
  /// The daemon's PHONECODE_HOME. The Mac app finds the daemon there and
  /// connects by itself, as it does with `~/.phonecode` for a real user.
  private var stateHome: String? { env["PC_UITEST_HOME"] }

  // MARK: helpers

  private func el(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  private func press(_ e: XCUIElement) {
    #if os(iOS)
      e.tap()
    #else
      e.click()
    #endif
  }

  @discardableResult
  private func wait(_ id: String, _ timeout: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let e = el(id)
    XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing \(id)", file: file, line: line)
    return e
  }

  private func shot(_ name: String) {
    #if os(iOS)
      let platform = "ios"
    #else
      let platform = "macos"
    #endif
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = "\(platform)-\(name)"
    a.lifetime = .keepAlways
    add(a)
  }

  private func launch(reset: Bool = true) {
    continueAfterFailure = false
    app = XCUIApplication()
    // -PCResetState also makes the Mac workspace ignore the layout the
    // system restores per window, so each test starts in a new chat.
    app.launchArguments = reset ? ["-PCResetState"] : []
    if let stateHome { app.launchEnvironment["PHONECODE_HOME"] = stateHome }
    // The tests run their own daemon; the Mac app must not start its bundled one.
    app.launchEnvironment["PC_NO_AUTOSTART"] = "1"
    app.launch()
  }

  private func type(_ id: String, _ text: String) {
    let e = wait(id)
    press(e)
    #if os(iOS)
      // The keyboard can take a moment; tap again if the field did not take focus.
      if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { press(e) }
      _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
    #endif
    e.typeText(text)
  }

  /// iPhone: pairs by typing the address and code, as a user without a camera
  /// would. Mac: the app connects to the daemon on this Mac by itself.
  private func pair() {
    #if os(macOS)
      if stateHome != nil {
        wait("composer-input", 30)
        return
      }
    #endif
    wait("pair-address")
    shot("01-pairing")
    type("pair-address", daemon)
    type("pair-code", code)
    press(el("pair-submit"))
    wait("composer-input", 30)
  }

  private func send(_ text: String) {
    type("composer-input", text)
    press(el("composer-send"))
  }

  /// Transcript text containing `text` (iOS puts it in the label, macOS in the value).
  private func said(_ text: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
  }

  /// A menu entry: by identifier, else (macOS sometimes drops identifiers of
  /// entries inside a menu Section) by its label or title, whatever kind of
  /// element the menu is drawn with.
  /// Opens the menu `menuId` and chooses `title`.
  private func choose(_ title: String, id: String, inMenu menuId: String) {
    press(wait(menuId))
    let entry = menuEntry(id, title)
    XCTAssertTrue(entry.waitForExistence(timeout: 5), "missing \(title) in \(menuId)")
    press(entry)
  }

  private func menuEntry(_ id: String, _ title: String) -> XCUIElement {
    let byId = el(id)
    if byId.waitForExistence(timeout: 2) { return byId }
    return app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@ OR title == %@", title, title)).firstMatch
  }

  private func dismissMenu() {
    #if os(iOS)
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
    #else
      app.typeKey(.escape, modifierFlags: [])
    #endif
  }

  // MARK: tests

  #if os(iOS)
  func test01PairAndFirstChat() throws {
    launch()
    pair()
    wait("new-chat-empty")
    shot("02-new-chat")

    // The pickers are native menus.
    press(wait("picker-harness"))
    XCTAssertTrue(app.buttons["Codex"].waitForExistence(timeout: 5) || app.menuItems["Codex"].waitForExistence(timeout: 1))
    shot("03-harness-picker")
    dismissMenu()
    press(wait("picker-mode"))
    shot("04-mode-picker")
    dismissMenu()

    send("hello there")
    wait("chat-item-user")
    wait("chat-item-text")
    wait("chat-item-turn", 30)
    shot("05-chat-streamed")
  }

  func test02PermissionToolsAndQuestion() throws {
    launch()
    pair()
    send("please run tests")
    let card = wait("chat-item-permission", 30)
    XCTAssertTrue(wait("permission-allow").exists)
    shot("06-permission")
    press(el("permission-allow"))
    wait("markdown-table", 30)
    wait("chat-item-tool")
    shot("07-tool-card-and-table")
    _ = card

    send("edit file")
    wait("permission-allow", 30)
    shot("08-permission-diff")
    press(el("permission-allow"))
    wait("diff-view", 30)
    shot("09-diff")

    send("ask me something")
    wait("question-option", 30)
    shot("10-question")
    // The card can still be scrolling into view: a click then misses the
    // option. Click until Submit is enabled (an option is chosen).
    let submit = wait("question-submit")
    for _ in 0..<5 where !submit.isEnabled {
      press(el("question-option"))
      sleep(1)
    }
    XCTAssertTrue(submit.isEnabled, "no option chosen")
    press(submit)
    wait("question-answer", 30)
  }

  func test03SidebarSearchAndArchive() throws {
    launch()
    pair()
    send("hello, remember the word pelican")
    wait("chat-item-turn", 30)
    #if os(iOS)
      // Back to the sidebar (the collapsed split view's first column).
      press(app.navigationBars.buttons.firstMatch)
    #endif
    wait("sidebar")
    wait("session-row")
    shot("11-sidebar")
    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 10))
    press(search)
    search.typeText("pelican")
    wait("search-result", 30)
    shot("12-search")
  }

  func test04ImageViewer() throws {
    launch()
    pair()
    send("take a screenshot")
    let image = wait("chat-image", 30)
    shot("13-chat-with-image")
    press(image)
    wait("image-viewer")
    shot("14-image-viewer")
    press(wait("image-viewer-close"))
  }

  func test05Terminal() throws {
    launch()
    pair()
    press(wait("picker-harness"))
    let terminal = el("picker-terminal")
    XCTAssertTrue(terminal.waitForExistence(timeout: 5))
    press(terminal)
    let view = wait("terminal-view", 30)
    press(view)
    app.typeText("echo phone-code-$((40+2))\r")
    sleep(2)
    shot("15-terminal")
  }

  /// The thinking level, in the model chip's menu: chosen before the first message, changed in the
  /// chat; the fake agent answers "thinking level" with the level it has.
  func test08ThinkingLevel() throws {
    #if os(macOS)
      // The model menu opens and lists the levels (checked by screenshot), but
      // on macOS 27 XCTest cannot reach the items of a SwiftUI menu with
      // sections: not by identifier, title or type-to-select. Covered by the
      // iOS run, the Core end-to-end tests and the web e2e tests.
      throw XCTSkip("XCTest cannot select items in this macOS menu")
    #endif
    launch()
    pair()
    choose("Max", id: "effort-max", inMenu: "picker-model")
    // One chip: "Sonnet Fake · Max".
    let chip = el("picker-model")
    // iOS puts a menu button's text in its label, macOS in its title.
    XCTAssertTrue((chip.label + chip.title).contains("Max"), "chip: \(chip.label) \(chip.title)")
    shot("19-thinking-level")
    send("what is your thinking level")
    wait("chat-item-turn", 30)
    let saidMax = said("Thinking level: max")
    XCTAssertTrue(saidMax.waitForExistence(timeout: 10), "the agent did not get max")

    choose("Low", id: "effort-low", inMenu: "picker-model")
    send("thinking level again")
    let saidLow = said("Thinking level: low")
    XCTAssertTrue(saidLow.waitForExistence(timeout: 30), "the change did not reach the agent")
  }
  #endif

  #if os(macOS)
    // The Mac app's window is the web app in a web view (Mac/WebShell.swift). What the
    // page itself does is tested in a browser (e2e/); these check the app around it:
    // it pairs by itself, the page works inside it, and the menu reaches the app's own parts.

    /// Something in the page, by its accessible name (an aria-label or its text).
    private func inPage(_ name: String) -> XCUIElement {
      app.webViews.descendants(matching: .any)
        .matching(NSPredicate(format: "label == %@ OR title == %@ OR placeholderValue == %@", name, name, name)).firstMatch
    }

    func test01MacShellChat() throws {
      try XCTSkipIf(stateHome == nil, "needs PC_UITEST_HOME")
      launch()
      XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30), "no web view")
      // No code to type: the app hands the page its pairing.
      let input = inPage("Message")
      XCTAssertTrue(input.waitForExistence(timeout: 30), "the page did not get to a chat")
      shot("01-shell-new-chat")
      input.click()
      input.typeText("hello there")
      let sendButton = inPage("Send")
      XCTAssertTrue(sendButton.waitForExistence(timeout: 5), "no send button")
      sendButton.click()
      let reply = app.webViews.staticTexts
        .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "fake Claude", "fake Claude")).firstMatch
      XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply in the page")
      sleep(2)
      shot("02-shell-chat")
    }

    /// The page's buttons right under the window's title strip take clicks (at their top
    /// edge too, where the strip is nearest), and pointing at the context ring names the tokens.
    func test03MacShellTopButtonsAndHover() throws {
      try XCTSkipIf(stateHome == nil, "needs PC_UITEST_HOME")
      launch()
      let input = inPage("Message")
      XCTAssertTrue(input.waitForExistence(timeout: 30), "the page did not get to a chat")

      let computer = inPage("This computer")
      XCTAssertTrue(computer.waitForExistence(timeout: 10), "no computer button")
      computer.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.2)).click()
      // The dialog's own close button: only there while it is open.
      let inDialog = inPage("Close")
      let opened = inDialog.waitForExistence(timeout: 10)
      sleep(1)
      shot("04-shell-computer")
      if !opened {
        // What the page looks like to the test, for the log (the screenshot is in the artifact).
        print("PCDIAG window \(app.windows.firstMatch.frame) computer \(computer.frame)")
        for line in app.webViews.firstMatch.debugDescription.split(separator: "\n").prefix(160) {
          print("PCDIAG \(line)")
        }
      }
      XCTAssertTrue(opened, "clicking the computer did not open its dialog")
      app.typeKey(.escape, modifierFlags: [])
      sleep(1)

      let split = inPage("New chat beside this one")
      XCTAssertTrue(split.waitForExistence(timeout: 10), "no split button")
      split.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).click()
      XCTAssertTrue(inPage("Close this pane").waitForExistence(timeout: 10), "the split button did not add a pane")
      shot("05-shell-tiles")
      inPage("Close this pane").click()
      sleep(1)

      let again = inPage("Message")
      again.click()
      again.typeText("hello there")
      inPage("Send").click()
      let ring = app.webViews.descendants(matching: .any)
        .matching(NSPredicate(format: "label BEGINSWITH %@", "Context ")).firstMatch
      XCTAssertTrue(ring.waitForExistence(timeout: 30), "no context ring after a turn")
      // The ring is at the right end of the composer's bar.
      // Pointed at where it is drawn: right under the send button, in the composer's bar.
      // (The frame accessibility reports for it is wider and lower than the ring itself.)
      print("PCDIAG ring \(ring.frame) send \(inPage("Send").frame)")
      let onRing = inPage("Send").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        .withOffset(CGVector(dx: -8, dy: 40))
      onRing.hover()
      sleep(1)
      shot("06-shell-context-hover")
      onRing.click()
      app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)).hover()
      sleep(1)
      shot("07-shell-context-pinned")
    }

    func test02MacShellPairAPhone() throws {
      try XCTSkipIf(stateHome == nil, "needs PC_UITEST_HOME")
      launch()
      XCTAssertTrue(inPage("Message").waitForExistence(timeout: 30), "the page did not get to a chat")
      app.typeKey("p", modifierFlags: [.command, .shift])
      wait("pair-phone-qr", 15)
      let code = el("pair-phone-code")
      XCTAssertFalse(code.label.isEmpty && (code.value as? String ?? "").isEmpty, "no pairing code shown")
      shot("03-shell-pair-a-phone")
    }
  #endif
}
