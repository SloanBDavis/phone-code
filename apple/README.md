# phone-code for iPhone and Mac

A native SwiftUI app for phone-code: the same chats as the web app, built from
system components (split view, lists, menus, sheets, Liquid Glass), plus a
tiling workspace on the Mac that shows several sessions at once.

It talks to the same `phonecode` daemon on your computer as the web app, over
the same protocol ([docs/protocol.md](../docs/protocol.md)). Nothing changes on
the computer.

> Status: early. See [What is verified](#what-is-verified) for what has been
> built and tested where. Nothing here has run on a physical device yet.

## Just want the Mac app?

No Xcode needed. On a Mac with Apple silicon and macOS 26 or newer, paste this into a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install-app.sh | sh
```

It installs the latest release's `PhoneCode.app` into `/Applications`; run it again to update. The app is not notarized (there is no Apple Developer account behind it), which is why it comes through `curl` and not a download link: macOS holds back an app downloaded in a browser until you allow it in **System Settings > Privacy & Security**.

The rest of this page is for building the apps yourself, which is the only way to get the iPhone app.

## What you need

- A Mac with **Xcode 26** or newer (free from the Mac App Store).
- An iPhone or iPad on **iOS/iPadOS 26** or newer, and/or a Mac on **macOS 26** or
  newer. The app uses the Liquid Glass design that came with these versions.
- An Apple Account. A free one works ("Personal Team"), with the limits below.
- `phonecode` running on your computer ([Get started](../README.md#get-started)).

## Run it on your Mac

1. `git pull` (or clone the repository).
2. Open `apple/PhoneCode.xcodeproj` in Xcode.
3. Xcode resolves the two packages (PhoneCodeCore from this repository and
   [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)). If it asks to
   **Trust & Enable** SwiftTerm's build plugin, accept: it only stamps the
   package's version into the build.
4. Click the **PhoneCode** project in the navigator, select the **PhoneCode**
   target, open **Signing & Capabilities**, and pick your team (your name with
   "(Personal Team)" for a free account).
5. Change the bundle identifier to something unique to you. The easy way: edit
   `apple/Config/Signing.xcconfig` and set `PC_BUNDLE_ID_PREFIX = com.yourname`
   (or create `apple/Config/Signing.local.xcconfig` with that line and your
   `DEVELOPMENT_TEAM = XXXXXXXXXX`; git ignores that file, so pulls never
   conflict).
6. In the toolbar, choose the **PhoneCode** scheme and **My Mac** as the
   destination, then press **⌘R**.
7. That's it: the Mac is the hub. The app finds `phonecode` running on this
   Mac (through `~/.phonecode/control.json`, the same local endpoint
   `phonecode pair` uses) and connects by itself, with no code to type. If
   phone-code is installed but not running, the app offers **Start
   phone-code**; if it is not installed, it shows the install command.
8. Pair your phone from the Mac: click the QR-code button in the toolbar
   (**Pair a phone**) and scan it with the iPhone app. **Settings > Phones**
   lists paired devices and revokes them.

The Mac app is not sandboxed: it reads `~/.phonecode` and can launch
`phonecode`. To drive phone-code on a *different* computer instead, use
**Connect to another computer…** on the first screen.

## Run it on your iPhone

1. Do steps 1 to 5 above.
2. Connect the iPhone with a cable (or pair it over Wi-Fi in Xcode's
   **Window > Devices and Simulators**), unlock it, and tap **Trust**.
3. On the iPhone, turn on **Settings > Privacy & Security > Developer Mode** and
   restart it when asked (Xcode prompts for this the first time).
4. Choose your iPhone as the destination and press **⌘R**.
5. With a free account, the first launch is refused: on the iPhone open
   **Settings > General > VPN & Device Management**, tap your Apple Account
   under "Developer App", and tap **Trust**. Then run again.
6. Pair: tap **Scan QR code** and point the camera at the QR code the Mac app
   shows (**Pair a phone**), or the one the `phonecode` banner prints. The phone must be able to reach the computer, which in practice
   means Tailscale (`phonecode setup` walks you through it).

### Free account ("Personal Team") limits

- The app stops opening after **7 days**; run it from Xcode again to renew it.
- At most **3** apps from a free account on a device at a time, and a limited
  number of new bundle identifiers per week.
- No push notifications and no associated domains (universal links). The app
  does not need either: it uses local notifications, and pairing links work
  through the `phonecode://` URL scheme and the QR scanner.
- A paid Apple Developer Program membership removes these limits.

## Using it

- **iPhone**: the app opens into a chat. Swipe from the left edge or tap the
  back button for the sidebar of chats ("Needs you" first). Swipe a chat to
  archive it; long-press it to rename, archive, copy the last response or
  delete. Search finds every conversation on the computer, from every agent,
  including ones started at the computer. The composer's chips pick the agent,
  model and thinking level (one chip, "Opus · High", when the model has
  levels), permission mode and folder; the first message creates the chat. Type
  `/` for the agent's slash commands. The photo button sends pictures.
- **Mac**: the same sidebar, and a workspace of tiles. Drag a chat from the
  sidebar onto the left, right, top or bottom edge of a tile to split it, or
  onto its middle to replace it. Drag a tile's title bar to move it. Drag the
  lines between tiles to resize. The layout is saved per window.

  | Shortcut | Action |
  | -------- | ------ |
  | ⌘N | New chat in the focused tile |
  | ⌘D / ⇧⌘D | Split right / split down |
  | ⌥⌘→ / ⌥⌘← | Next / previous tile |
  | ⌃⌘W | Close tile |
  | ⌘F | Search all chats |
  | ⌃⌘S | Show or hide the sidebar |
  | ⌘↩ | Send |

- **This computer** (iPhone: the computer icon in the sidebar; Mac: Settings,
  ⌘,): the connection, which agents are ready and how to set up the others,
  notifications, and unpairing.

## Notifications

The app posts **local** notifications when a chat starts waiting for you
(a permission or a question) or an agent finishes, while the app is open or
for the short time iOS keeps it running after you leave it (about 30 seconds).
Turn them on in **This computer > Notify me**.

Notifications while the app is closed would need Apple Push Notification
service (APNs), which phone-code does not support. What it would take:

1. **An Apple Developer Program membership** (paid). Free accounts cannot use
   the Push Notifications capability.
2. **The capability in the app**: the `aps-environment` entitlement, and code
   that calls `registerForRemoteNotifications()` and sends the resulting
   device token to the daemon.
3. **A protocol addition**: today `push.subscribe` carries a Web Push
   subscription. APNs needs a new message (or a tagged variant) carrying the
   device token, the bundle id and the APNs environment (development or
   production), stored per device next to the Web Push subscriptions in the
   daemon.
4. **An APNs key on the computer**: a `.p8` signing key created in the
   developer account (Certificates, Identifiers & Profiles > Keys), with its
   Key ID and the Team ID. The daemon signs an ES256 JWT with it (refreshed at
   most every 20 to 60 minutes) and sends HTTP/2 requests to
   `api.push.apple.com` (or `api.sandbox.push.apple.com` for development
   builds) with `apns-topic` set to the bundle id. `packages/daemon/src/push.ts`
   would gain this as a second transport, reusing its rate limiting and
   payloads (`PushPayload`).
5. **Each user's own key**: since everyone builds the app under their own
   team, every user would need their own paid membership and key. A shared
   relay would avoid that but would mean running a phone-code server, which
   the project deliberately does not have.

## How it is built

```
apple/
  PhoneCodeCore/          Swift package, Foundation only (builds and is tested on Linux)
    Sources/PhoneCodeCore/
      Models.swift        protocol types; unknown fields, kinds and enum values never fail decoding
      Messages.swift      daemon frames (decoded in one pass) and client messages
      Connection.swift    the WebSocket client: hello, ping, backoff, afterSeq resubscribe, rpc, outbox
      WebSocket.swift     URLSessionWebSocketTask on Apple platforms
      POSIXWebSocket.swift a small RFC 6455 client for Linux (tests)
      Store.swift         PhoneCodeClient: sessions, transcripts (one observable box per item), sends
      Pairing.swift       pairing links, POST /api/pair, handoff, unpair
      LocalDaemon.swift   the daemon on this computer via its control endpoint (Mac hub)
      Images.swift        image fetch with the bearer token, LRU cache
      Markdown.swift      markdown blocks, code highlighting, unified diffs
      Workspace.swift     the Mac tiling layout as a split tree
      Attention.swift     when to notify
      Agents.swift        harness, model and mode helpers, new-chat defaults, slash commands
    Tests/PhoneCodeCoreE2E/  end-to-end tests against the real daemon and fake agents
  PhoneCode/              the SwiftUI app (one target for iOS and macOS)
  PhoneCodeUITests/       XCUITests against the real daemon, with screenshots
  project.yml             XcodeGen spec; PhoneCode.xcodeproj is generated from it and committed
  Config/                 signing, Info.plist additions, macOS entitlements
  scripts/gen-icons.mjs   renders the app icon from the web app's icon
```

Decisions:

- **SwiftUI, one multiplatform target**: one codebase for iPhone, iPad and Mac,
  with the system's split view, menus, search, drag and drop and Liquid Glass.
- **Deployment target iOS 26 / macOS 26**: the first versions with Liquid Glass
  (`glassEffect`, `.glass` button styles). CI builds with the Xcode 26 that
  GitHub's `macos-26` runner image ships.
- **Committed `.xcodeproj` generated by XcodeGen**: you open the project without
  installing anything; CI regenerates it from `project.yml` to catch drift.
  The app's sources are a synchronized folder, so adding a file needs no
  regeneration.
- **Markdown without a dependency**: block structure (headings, lists, code
  fences, tables, quotes) is parsed in PhoneCodeCore and tested on Linux;
  inline styles use `AttributedString(markdown:)`; code is highlighted by a
  small lexer in Core. It re-parses one message per streamed delta, which is
  cheap, and an unterminated code fence still renders as code.
- **Terminal: SwiftTerm** (MIT, iOS and macOS, maintained), pinned to 1.99.3.
  The app feeds it `term.snapshot` (after a full reset) and `term.data`, and
  sends keystrokes as `term.input` and size changes as `term.resize`.
- **Speed**: frames are decoded on the `Connection` actor, off the main thread;
  each transcript item is its own `@Observable` object, so a streaming delta
  redraws one row.
- **The token** lives in the Keychain on iPhone (this device only). On the Mac it is a
  file only you can read (`~/Library/Application Support/<bundle id>/credentials.json`):
  the Keychain would ask again after every local rebuild, and protects nothing extra
  next to phone-code's own control token in `~/.phonecode`.

## Tests

Project policy is end-to-end tests only. Two suites:

- `PhoneCodeCore` (`swift test` in `apple/PhoneCodeCore`, on Linux or macOS):
  starts the real daemon (`bun packages/daemon/src/cli.ts --local`) with the
  scripted fake agents from `e2e/fakes`, pairs over HTTP, and drives it through
  the Core client: first send, streaming, permissions, questions, every
  harness, todos, sub-agents, diffs, slash commands, interrupt, images,
  archive and search, reconnect with `afterSeq`, daemon restart, revoke,
  unpair, handoff, terminals, and the Mac workspace layout. Needs `bun` and
  `bun install` at the repository root.
- `PhoneCodeUITests` (Xcode, on the iOS simulator and on macOS): CI starts a
  daemon with the fake agents and a fixed pairing code, then the tests pair
  through the UI and capture every main screen. See
  [.github/workflows/apple.yml](../.github/workflows/apple.yml).

## What is verified

| Feature | Linux end-to-end | Compiled in CI | UI-tested in simulator / on macOS | On a device |
| ------- | ---------------- | -------------- | --------------------------------- | ----------- |
| Core protocol client, store, pairing, images, workspace model, local hub | yes | yes (macOS) | n/a | never run |
| App (all screens) | n/a | yes | yes: macOS 27 (Xcode 27.2), iOS 26.2 simulator | never run |

Verified on a Mac with Xcode 27.2: `swift test` (13 tests) and the UI tests on
macOS and the iOS simulator, against the real daemon with the fake agents.

## Troubleshooting

- **"Could not reach your computer"** when pairing: the address must be the one
  the phone can reach (your Tailscale name, e.g. `https://mac.tailnet.ts.net`),
  not `127.0.0.1`, unless the app runs on the same Mac as `phonecode`.
- **Package resolution fails**: Xcode > File > Packages > Reset Package Caches.
- **"Untrusted Developer"** on the iPhone: see step 5 above.
- Something else: open an issue with Xcode's error (the Report navigator, ⌘9,
  shows the full build log).
