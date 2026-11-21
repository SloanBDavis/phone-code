# Test ids

Stable `data-testid` hooks for the end-to-end suite. Extra `data-*` attributes noted
in brackets carry state worth asserting on.

Demo mode (`/?demo=1`) gives deterministic fixtures: sessions `demo-auth` (pending
permission), `demo-billing` (running Codex), `demo-chart` (pending question),
`demo-shell` (terminal), `demo-vite` (finished turn with sub-agent, todos, table, code),
`demo-dev` (exited terminal), `demo-notes`. `?demo=1&demoItems=2000` adds `demo-long`.

## Screens

| id                                 | element                        |
| ---------------------------------- | ------------------------------ |
| `screen-pair`                      | pairing flow root              |
| `screen-sessions`                  | home list                      |
| `screen-chat`                      | agent chat [`data-session-id`] |
| `screen-terminal`                  | terminal [`data-session-id`]   |
| `screen-settings`                  | settings                       |
| `screen-loading`, `screen-missing` | session not loaded yet / gone  |

## Pairing

| id                                              | element                                                        |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `pair-auto`                                     | auto-pairing in progress (`/#/pair?c=` or `/?h=`)              |
| `pair-error`, `pair-error-continue`             | pairing failed, continue to manual pairing                     |
| `pair-manual`                                   | manual pairing screen                                          |
| `pair-reason`                                   | why we are pairing again (e.g. device revoked)                 |
| `pair-scan`                                     | open the QR scanner                                            |
| `scanner-sheet`, `scanner`, `scanner-close`     | scanner sheet                                                  |
| `pair-input`, `pair-submit`, `pair-input-error` | paste link or code                                             |
| `pair-demo`                                     | "Try the demo"                                                 |
| `pair-install`, `pair-continue`                 | Add to Home Screen coach (iOS Safari only), continue in Safari |

## Sessions

| id                                                              | element                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `conn-state`                                                    | connection label [`data-status`: connecting, open, reconnecting, offline, unauthorized] |
| `conn-retry`                                                    | retry link while reconnecting/offline                                                   |
| `demo-banner`                                                   | demo notice                                                                             |
| `section-waiting`, `section-running`, `section-recent`          | list sections                                                                           |
| `session-row`                                                   | a row [`data-session-id`, `data-status`]                                                |
| `session-unread`                                                | unread dot inside a row                                                                 |
| `session-rename`, `session-delete`                              | swipe actions                                                                           |
| `sessions-empty`, `empty-new`                                   | empty state and its button                                                              |
| `new-session`                                                   | floating New button                                                                     |
| `open-settings`                                                 | settings button                                                                         |
| `rename-dialog`, `rename-dialog-input`, `rename-dialog-confirm` | rename alert                                                                            |
| `delete-dialog`, `delete-dialog-confirm`                        | delete confirmation                                                                     |
| `toast`                                                         | transient toast                                                                         |
| `nav-back`                                                      | back button on pushed screens                                                           |

## New session sheet

| id                                                                           | element                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `new-session-sheet`, `new-session-close`                                     | sheet and its close button                             |
| `new-kind-claude`, `new-kind-codex`, `new-kind-terminal`                     | type tiles [`aria-pressed`, disabled when unavailable] |
| `new-folder`                                                                 | folder row (opens picker)                              |
| `new-recent-dir`                                                             | recent folder chip                                     |
| `new-model`, `new-permission`                                                | model / permission rows (open menus)                   |
| `new-start`                                                                  | start button                                           |
| `resume-row`                                                                 | a resumable past session                               |
| `folder-picker`, `folder-back`, `folder-up`, `folder-entry`, `folder-choose` | folder picker                                          |

## Chat

| id                                                                                                      | element                                             |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `chat-title`, `chat-menu-btn`, `chat-menu`                                                              | title capsule, menu button, the menu                |
| `menu-rename`, `menu-copy`, `menu-delete`                                                               | menu items                                          |
| `transcript`                                                                                            | transcript container                                |
| `chat-item-user`, `chat-item-text` [`data-streaming`], `chat-item-thinking`                             | messages                                            |
| `chat-item-tool` [`data-tool`, `data-status`], `tool-group`, `diff-view`                                | tool calls                                          |
| `chat-item-todo`, `todo-list`, `chat-item-task` [`data-status`]                                         | plan and sub-agent cards                            |
| `chat-item-permission` [`data-status`]                                                                  | permission card                                     |
| `permission-allow`, `permission-allow-always`, `permission-deny`                                        | its buttons                                         |
| `permission-deny-feedback`, `permission-deny-message`, `permission-deny-send`                           | deny with a message                                 |
| `chat-item-question` [`data-status`]                                                                    | question card                                       |
| `question-option`, `question-other`, `question-other-input`, `question-submit`                          | its controls                                        |
| `chat-item-notice`, `chat-item-turn` [`data-outcome`]                                                   | notices, turn footers                               |
| `chat-item-pending` [`data-status`: sending, failed]                                                    | optimistic user bubble                              |
| `ask-bar` [`data-kind`], `askbar-allow`, `askbar-deny`, `askbar-answer`                                 | sticky ask bar (hidden while its card is on screen) |
| `jump-latest`                                                                                           | jump-to-latest pill                                 |
| `composer`, `composer-input`, `composer-send`, `composer-stop`                                          | composer                                            |
| `composer-attach`, `composer-file`                                                                      | photo button, hidden file input                     |
| `composer-mode`, `mode-menu`, `mode-default`, `mode-acceptEdits`, `mode-plan`, `mode-bypassPermissions` | permission mode                                     |
| `composer-model`, `model-menu`, `model-<name>`                                                          | model switch                                        |

## Terminal

| id                                                                                                                                                     | element              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `terminal`                                                                                                                                             | xterm container      |
| `term-title`                                                                                                                                           | title capsule (menu) |
| `term-font-smaller`, `term-font-larger`                                                                                                                | text size            |
| `term-keybar`                                                                                                                                          | accessory key bar    |
| `key-esc`, `key-tab`, `key-ctrl`, `key-alt` [`aria-pressed`], `key-left`, `key-up`, `key-down`, `key-right`, `key-paste`, `key-ctrl-c`, `key-keyboard` | keys                 |

## Settings

| id                                                                    | element                    |
| --------------------------------------------------------------------- | -------------------------- |
| `settings-notifications`                                              | notifications switch       |
| `theme-system`, `theme-dark`, `theme-light`                           | theme segments             |
| `settings-font-smaller`, `settings-font-size`, `settings-font-larger` | terminal text size         |
| `settings-unpair`, `unpair-dialog`, `unpair-dialog-confirm`           | unpair                     |
| `settings-exit-demo`                                                  | exit demo (demo mode only) |
| `settings-source`                                                     | source link                |
