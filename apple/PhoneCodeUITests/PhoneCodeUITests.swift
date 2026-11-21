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
    app.launchArguments = reset ? ["-PCResetState"] : []
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

  /// Pairs by typing the address and code, as a user without a camera would.
  private func pair() {
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

  private func dismissMenu() {
    #if os(iOS)
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
    #else
      app.typeKey(.escape, modifierFlags: [])
    #endif
  }

  // MARK: tests

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
    press(el("question-option"))
    press(el("question-submit"))
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
    let terminal = app.buttons["Terminal"].exists ? app.buttons["Terminal"] : app.menuItems["Terminal"]
    XCTAssertTrue(terminal.waitForExistence(timeout: 5))
    press(terminal)
    let view = wait("terminal-view", 30)
    press(view)
    app.typeText("echo phone-code-$((40+2))\r")
    sleep(2)
    shot("15-terminal")
  }

  #if os(macOS)
    func test06MacWorkspaceThreeTiles() throws {
      launch()
      pair()
      send("hello from tile one")
      wait("chat-item-turn", 30)
      app.typeKey("d", modifierFlags: .command)
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "tile").element(boundBy: 1).waitForExistence(timeout: 10))
      let inputs = app.descendants(matching: .any).matching(identifier: "composer-input")
      press(inputs.element(boundBy: 1))
      inputs.element(boundBy: 1).typeText("hello from tile two\r")
      app.typeKey("d", modifierFlags: [.command, .shift])
      XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "tile").element(boundBy: 2).waitForExistence(timeout: 10))
      sleep(3)
      shot("16-mac-workspace-three-tiles")
      // Rearrange: drag the first tile's title bar onto the bottom edge of the last tile.
      let titles = app.descendants(matching: .any).matching(identifier: "tile-title")
      let tiles = app.descendants(matching: .any).matching(identifier: "tile")
      let target = tiles.element(boundBy: 2).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
      titles.element(boundBy: 0).coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).press(forDuration: 0.5, thenDragTo: target)
      sleep(1)
      shot("17-mac-workspace-rearranged")
      XCTAssertEqual(tiles.count, 3)
    }
  #endif
}
