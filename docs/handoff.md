# Handoff: state of the work as of 0.2.5

For whoever picks this up next (a session on the Mac, most likely). Everything
below was built in a Linux cloud session that could not run the Mac app, the
real Cursor app, or the real Codex and Antigravity CLIs. Delete this file once
its open items are done.

## Shipped

| Release | What                                                                                                                                                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2   | Cursor: a finished turn waits for a phone reply while nobody is at the Mac (no input for 2 min), up to 8 h; the chat says "Waiting for your reply" or "Continue in Cursor".                                                                                                         |
| 0.2.3   | The Mac app is in releases (`PhoneCode-mac.zip`, Apple silicon, ad hoc signed). iPhone UI tests run only from "Run workflow".                                                                                                                                                       |
| 0.2.4   | One `install.sh` for the command, the app or both. `phonecode update` and the offer at startup. The app updates itself. Mac app: full-width chat, tables, diffs, Cursor chats folded away, "All chats on this computer". Sub-agent messages inside their card (Claude Code, Codex). |
| 0.2.5   | Background commands (Claude Code) stream their output file into the card; a "Running" strip in the web app; context % and tokens in the turn footer; Codex: no deny note where it is dropped, history up to 500 turns.                                                              |

## Never run for real: check these first on the Mac

1. **Installer question.** `curl … install.sh | sh` in a terminal on the Mac: the 1/2/3 prompt reads from `/dev/tty`. Only the non-interactive paths ran in CI.
2. **Gatekeeper.** Whether macOS opens the curl-installed, un-notarized app without the "unverified developer" block.
3. **In-app update.** `apple/PhoneCode/Mac/Updater.swift`: the alert on launch, PhoneCode > Check for Updates, Settings > Updates, and the quit / swap / reopen. CI only tests the installer side of it (`PHONECODE_WAIT_PID`, `PHONECODE_READY_FILE`).
4. **`phonecode update` and the startup prompt** against a real GitHub release (tested against a local stand-in).
5. **Cursor away-reply** (`packages/daemon/src/agents/cursor-app.ts`): what Cursor shows while the stop hook is held, and whether it honours the 8 h 5 min hook timeout in `~/.cursor/hooks.json`.
6. **Sidebar resizing.** The owner could not resize the sidebar in 0.2.3. The UI test (`test09MacSidebarResizeAndAllChats`) drags the split view's edge and the width does change, so the cause is unknown.
7. **Codex sub-agents** (`codex.ts` `onCollab`, `onSubNotification`): written from memory of `collabAgentToolCall` (`tool`, `receiverThreadIds`, `agentsStates`), checked only against `e2e/fakes/fake-codex.mjs`, which encodes the same assumptions. Run `codex app-server generate-ts --out <dir>` and compare.
8. **Context usage for Codex and ACP**: `tokenUsage.last.totalTokens` / `modelContextWindow`, and ACP `usage_update.used` / `size`. Assumed field names.
9. **Claude Code background commands**: relies on the Bash result text "Command running in background with ID: <id>. Output is being written to: <file>" and on a `task_notification` system message or `<task-notification>` text when the command ends. The first was seen in a real session; the ending signals are assumed.
10. **Mac app sub-agent view.** Text and thinking children render through the existing `ToolCard` children loop; it compiles, but no UI test or screenshot covers it. The final report may show twice (the web card de-duplicates it, the Swift one does not).

## Not done

- **Running strip in the Mac app** (web only: `RunningStrip` in `packages/web/src/screens/chat/tools.tsx`).
- **Antigravity / ACP**: offer agent modes `mapModes` cannot classify (needs custom modes in the protocol and both pickers); a stop button for ACP terminals (needs a client message and a `stoppable` flag on tool items).
- **Codex slash commands** beyond `/compact` and `/review`: needs the real schema.
- **Stop for a Claude Code background command**: the CLI offers no way from outside.
- **Web sidebar**: Cursor chats are still mixed into the main list there (the Mac app folds them).
- **"Cursor" filter chip** in All chats lists `cursor-agent` CLI chats, not the desktop app's; confusing.
- **Mac app polish** the owner asked for beyond the fixed defects: code blocks and the general look of the transcript ("feels simple").
- **npm**: no release since 0.2.1 has been published to npm (manual step in CONTRIBUTING.md).

## How things are done here

- **Releasing**: bump the version (three `package.json`, `bun.lock`, `apple/project.yml`, `project.pbxproj`), push to `main`, then run the Release workflow on `main` ("Run workflow"); it creates the tag. Do not push to `main` while it runs: GitHub's token then cannot create the tag (403).
- **Seeing the Mac app without a Mac**: the Apple workflow's `apple-macos` artifact has a screenshot of every main screen and `uitests-macos.log`.
- **iPhone UI tests**: Apple workflow > Run workflow, platform `ios`, optionally `only: test01PairAndFirstChat …`.
- **Known flaky**: `e2e/tests/sessions.spec.ts` "archive: swipe…" (touch gesture) and the Mac UI test's wait for `permission-allow`; UI tests retry once.
