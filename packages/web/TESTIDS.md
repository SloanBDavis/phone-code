# Test ids

Stable `data-testid` hooks for the end-to-end suite. Extra `data-*` attributes noted
in brackets carry state worth asserting on.

Demo mode (`/?demo=1`) gives deterministic fixtures: sessions `demo-auth` (pending
permission), `demo-billing` (running Codex), `demo-chart` (pending question),
`demo-shell` (terminal), `demo-vite` (finished turn with sub-agent, todos, table, code),
`demo-dev` (exited terminal), `demo-gemini` (finished turn of an ACP-backed agent, Gemini CLI),
`demo-notes`, `demo-design` (images in a bubble, a tool card and a message), `demo-ci` (archived).
The demo host also has Antigravity not installed, slash commands, and All-chats results from four harnesses. `?demo=1&demoItems=2000` adds `demo-long`.

## Shell

| id                            | element                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `shell`                       | app shell [`data-drawer`: open, closed; class `wide` on two-pane layouts]       |
| `sidebar`, `sidebar-list`     | the chats sidebar (drawer on phones) and its scrolling list                     |
| `open-sidebar`, `new-chat`    | top-bar buttons on phones: open the drawer, start a new chat                    |
| `edge-swipe`, `drawer-scrim`  | left-edge strip that drags the drawer open; dimmed chat that drags/taps it shut |
| `screen-chat`                 | chat pane [`data-session-id` (empty in a new chat), `data-draft`]               |
| `screen-terminal`             | terminal [`data-session-id`]                                                    |
| `screen-loading`              | a session not loaded yet                                                        |
| `lazy-loading`, `lazy-failed` | a code-split view loading / failed to load (with retry)                         |
| `toast`, `toast-undo`         | transient toast, its Undo action (after Archive)                                |

## Pairing

| id                                              | element                                                        |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `screen-pair`                                   | pairing flow root                                              |
| `pair-auto`                                     | auto-pairing in progress (`/#/pair?c=` or `/?h=`)              |
| `pair-error`, `pair-error-continue`             | pairing failed, continue to manual pairing                     |
| `pair-manual`                                   | manual pairing screen                                          |
| `pair-reason`                                   | why we are pairing again (e.g. device revoked)                 |
| `pair-scan`                                     | open the QR scanner                                            |
| `pair-scan-unavailable`                         | why there is no scanner (plain http)                           |
| `pair-insecure`                                 | install coach: what plain http leaves out                      |
| `scanner-sheet`, `scanner`, `scanner-close`     | scanner sheet                                                  |
| `pair-input`, `pair-submit`, `pair-input-error` | paste link or code                                             |
| `pair-demo`                                     | "Try the demo"                                                 |
| `pair-install`, `pair-continue`                 | Add to Home Screen coach (iOS Safari only), continue in Safari |

## Sidebar

| id                                                              | element                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `open-computer`                                                 | host name + connection, opens "This computer"                                                          |
| `conn-state`                                                    | connection label [`data-status`: connecting, open, reconnecting, offline, unauthorized; `data-secure`] |
| `conn-retry`                                                    | retry link while reconnecting/offline                                                                  |
| `sidebar-new-chat`                                              | New chat                                                                                               |
| `demo-banner`                                                   | demo notice                                                                                            |
| `section-waiting`, `section-chats`                              | "Needs you" and the other chats                                                                        |
| `session-row`                                                   | a row [`data-session-id`, `data-status`, `data-agent` (agent id, agent sessions only)]                 |
| `session-unread`                                                | unread dot inside a row                                                                                |
| `session-archive`                                               | swipe action (a full swipe runs it)                                                                    |
| `row-menu`, `menu-rename`, `menu-archive`, `menu-delete`        | long-press / right-click menu of a row                                                                 |
| `sessions-empty`                                                | no chats yet                                                                                           |
| `rename-dialog`, `rename-dialog-input`, `rename-dialog-confirm` | rename alert                                                                                           |
| `delete-dialog`, `delete-dialog-confirm`                        | delete confirmation                                                                                    |

## All chats (search)

| id                                                                  | element                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `search-input`, `search-cancel`                                     | the search field at the top of the sidebar, leave search          |
| `all-chats`                                                         | results panel                                                     |
| `history-filter-all`, `history-filter-<agentId>`                    | harness filter chips                                              |
| `history-row`                                                       | a conversation [`data-agent`, `data-session-id`, `data-archived`] |
| `history-snippet`                                                   | excerpt around the match                                          |
| `history-loading`, `history-empty`, `history-error`, `history-more` | states and paging                                                 |

## New chat and pickers

| id                                                                                                             | element                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `new-chat-empty`                                                                                               | new chat's empty state [`data-state`: ready, setup, no-agent]                                              |
| `starter`                                                                                                      | a starter prompt (fills the composer)                                                                      |
| `harness-hint`, `setup-hints`                                                                                  | setup hint of the chosen harness; hints when no agent is installed                                         |
| `http-note`, `http-note-dismiss`                                                                               | plain-http note, shown once                                                                                |
| `composer-harness`, `harness-menu`, `harness-<id>`                                                             | harness chip [`data-harness`], its menu, an entry (`terminal` included; unavailable ones have class `dim`) |
| `setup-dialog`, `setup-dialog-confirm`                                                                         | how to set up an unavailable harness (copy the command)                                                    |
| `composer-folder`                                                                                              | folder chip (new chats only)                                                                               |
| `folder-sheet`, `folder-picker`, `folder-close`, `folder-recent`, `folder-up`, `folder-entry`, `folder-choose` | folder picker                                                                                              |
| `composer-slash`, `slash-palette`, `slash-group` [`data-source`], `slash-item` [`data-command`]                | slash commands                                                                                             |

## This computer

| id                                                                    | element                                        |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| `computer-sheet`, `screen-settings`, `computer-close`                 | the sheet, its content, close                  |
| `connection-mode` [`data-mode`]                                       | how the phone reaches the host, in plain words |
| `works-chat`, `works-notifications`, `works-offline`, `works-scanner` | what works on this connection [`data-ok`]      |
| `connection-fix`                                                      | the step to get https                          |
| `settings-agent` [`data-agent`], `setup-hint`                         | a harness and why it is not set up             |
| `settings-notifications`, `notifications-note`                        | notifications switch and why                   |
| `theme-system`, `theme-dark`, `theme-light`                           | theme segments                                 |
| `settings-font-smaller`, `settings-font-size`, `settings-font-larger` | terminal text size                             |
| `settings-unpair`, `unpair-dialog`, `unpair-dialog-confirm`           | unpair                                         |
| `settings-exit-demo`                                                  | exit demo (demo mode only)                     |
| `settings-source`                                                     | source link                                    |

## Chat

| id                                                                                           | element                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `chat-title`, `chat-menu`                                                                    | title capsule (opens the menu), the menu            |
| `menu-rename`, `menu-copy`, `menu-archive`, `menu-delete`                                    | menu items                                          |
| `transcript`                                                                                 | transcript container                                |
| `chat-item-user`, `chat-item-text` [`data-streaming`], `chat-item-thinking`                  | messages                                            |
| `chat-item-tool` [`data-tool`, `data-status`], `tool-group`, `diff-view`                     | tool calls                                          |
| `chat-item-todo`, `todo-list`, `chat-item-task` [`data-status`]                              | plan and sub-agent cards                            |
| `chat-item-permission` [`data-status`]                                                       | permission card                                     |
| `permission-allow`, `permission-allow-always`, `permission-deny`                             | its buttons                                         |
| `permission-deny-feedback`, `permission-deny-message`, `permission-deny-send`                | deny with a message (not for ACP agents)            |
| `chat-item-question` [`data-status`]                                                         | question card                                       |
| `question-option`, `question-other`, `question-other-input`, `question-submit`               | its controls                                        |
| `chat-item-notice`, `chat-item-turn` [`data-outcome`]                                        | notices, turn footers                               |
| `chat-item-pending` [`data-status`: sending, failed]                                         | optimistic user bubble                              |
| `ask-bar` [`data-kind`], `askbar-allow`, `askbar-deny`, `askbar-answer`                      | sticky ask bar (hidden while its card is on screen) |
| `jump-latest`                                                                                | jump-to-latest pill                                 |
| `composer`, `composer-input`, `composer-send`, `composer-stop`                               | composer                                            |
| `composer-attach`, `composer-file`, `composer-att`, `att-remove`                             | add photos, file input, a thumbnail, remove it      |
| `chat-image` (class `loaded`), `upload-progress`                                             | an image in a bubble/message/tool card, upload ring |
| `image-viewer` [`data-index`, `data-zoomed`], `viewer-count`, `viewer-close`, `viewer-share` | full-screen viewer                                  |

## Terminal

| id                                                                                                                                                     | element              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `terminal`                                                                                                                                             | xterm container      |
| `term-title`                                                                                                                                           | title capsule (menu) |
| `term-font-smaller`, `term-font-larger`                                                                                                                | text size            |
| `term-keybar`                                                                                                                                          | accessory key bar    |
| `key-esc`, `key-tab`, `key-ctrl`, `key-alt` [`aria-pressed`], `key-left`, `key-up`, `key-down`, `key-right`, `key-paste`, `key-ctrl-c`, `key-keyboard` | keys                 |
