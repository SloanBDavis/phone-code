# Fake agents for the e2e suite

Executable, dependency-free scripts that stand in for the real CLIs. The
adapters in `packages/daemon/src/agents/` cannot tell them from the real
binaries. Point the daemon at them with:

```sh
PHONECODE_CLAUDE_BIN=$PWD/e2e/fakes/fake-claude.mjs \
PHONECODE_CODEX_BIN=$PWD/e2e/fakes/fake-codex.mjs \
PHONECODE_GEMINI_BIN=$PWD/e2e/fakes/fake-acp.mjs \
CLAUDE_CONFIG_DIR=/tmp/fake-claude-home \
CODEX_HOME=/tmp/fake-codex-home \
bun packages/daemon/src/cli.ts
```

All scripts start with `#!/usr/bin/env bun` and also run under node.
`FAKE_SPEED=4` makes every delay 4x shorter.

## fake-claude.mjs

It speaks Claude Code's stream-json protocol, which is also what
`@anthropic-ai/claude-agent-sdk` speaks:

```
claude --output-format stream-json --verbose --input-format stream-json \
       --include-partial-messages --permission-prompt-tool stdio \
       [--model m] [--permission-mode m] [--session-id id | --resume id]
```

The framing comes from a capture of the real exchange between the Agent SDK
0.3.330 and Claude Code 2.1.330, recorded with a logging wrapper used as
`pathToClaudeCodeExecutable`. The capture covered a plain reply, a
permission-gated `Bash` call (allow with suggestions, and deny), an interrupt in
the middle of a stream, `set_permission_mode` and `set_model`. The capture
itself is not checked in, because it contains machine-specific data. The fake
copies these parts of it:

- control requests from the host: `initialize` (the response includes
  `models`), `interrupt` (`{still_queued: []}`), `set_permission_mode`
  (followed by `system/status` carrying `permissionMode`), `set_model` and
  `set_max_thinking_tokens` (only its `thinking_display` is used: as in the
  real CLI in print mode, thinking blocks arrive empty unless the host asks
  for `summarized`).
- `can_use_tool` control requests carrying `permission_suggestions` and
  `tool_use_id`. The host answers with `{behavior:'allow', updatedInput,
  updatedPermissions?}` or `{behavior:'deny', message}`. When the host
  interrupts, the fake sends `control_cancel_request`.
- the order of a turn: `session_state_changed: running`, `system/init`, then
  the `stream_event` frames (`message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`,
  `message_stop`). The fake sends one `assistant` message per content block,
  after that block's deltas and before its `content_block_stop`. Next come
  `user` tool results with `tool_use_result` and `tool_result_meta`, then
  `result` (`total_cost_usd` is cumulative for the process), then
  `session_state_changed: idle`.
- interrupts: the fake sends the partial `assistant` block, then
  `[Request interrupted by user]`, then `result` with subtype
  `error_during_execution`.
- the session transcript: the fake writes
  `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session>.jsonl`, so `--resume`,
  the replay of past turns and `listResumable` all work. Sub-agents go where
  2.1.330 puts them: `<session>/subagents/agent-<id>.jsonl` (`isSidechain`,
  `agentId`) with an `agent-<id>.meta.json` holding the starting `toolUseId`;
  the Task result's `toolUseResult` carries the `agentId`.

A rule saved with "always allow" (an `addRules` suggestion) lasts for the life
of the process. A `setMode` update changes the mode, as in the real CLI.

| prompt contains                              | what happens                                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/cost`, `/usage`, `/context` (at the start) | a local slash command as 2.1.330 runs one: a single synthetic assistant message (model `<synthetic>`), no model call                                                                                                                          |
| `screenshot`                                 | a `Read` of `shot.png` whose tool result is an image block (a 1x1 PNG)                                                                                                                                                                        |
| `close input`                                | answers, then closes its stdin and keeps running (the host's next long enough write fails with EPIPE)                                                                                                                                         |
| `late ask`                                   | answers and ends the turn, then asks for permission to run `Bash git fetch` outside any turn                                                                                                                                                  |
| `background decision`                        | reports what the host answered to that late request (`Background request: deny (interrupt)`, …)                                                                                                                                               |
| `crash`                                      | streams a few words, writes to stderr, exits with code 3 in the middle of the turn                                                                                                                                                            |
| `hello`                                      | streams a short markdown answer word by word                                                                                                                                                                                                  |
| `think`                                      | streams a thinking block, then the answer                                                                                                                                                                                                     |
| `run tests`                                  | sends text, then `Bash npm test` and asks for permission (unless always-allowed or the mode is `bypassPermissions`). If allowed: test output, then a markdown table. If denied: an acknowledgement                                            |
| `failing`                                    | runs `Bash ls ./does-not-exist`, which fails with `Exit code 2` (no permission needed)                                                                                                                                                        |
| `edit file`                                  | creates `notes.md` in cwd with `Write`, or changes it with `Edit` if it exists (`hello world` becomes `hello phone-code` plus one line). Asks for permission unless the mode is `acceptEdits` or `bypassPermissions`. The file really changes |
| `ask me`                                     | an `AskUserQuestion` with 2 options. The answer comes back in `updatedInput.answers`                                                                                                                                                          |
| `todo`                                       | `TodoWrite` 4 times as 3 items move from pending to in_progress to completed (about 0.5 s apart)                                                                                                                                              |
| `agent` / `task`                             | a `Task` tool whose sub-agent runs `Bash ls`. Those messages carry `parent_tool_use_id`                                                                                                                                                       |
| `plan`                                       | `ExitPlanMode` with a markdown plan. Allowing it applies the host's `setMode`                                                                                                                                                                 |
| `long`                                       | streams 100 words over about 10 s (for testing interrupt)                                                                                                                                                                                     |
| `compact`                                    | `status: compacting`, then a `compact_boundary`                                                                                                                                                                                               |
| `rate limit`                                 | an `allowed_warning` `rate_limit_event` and an `api_retry`                                                                                                                                                                                    |
| anything else                                | `You said: …`                                                                                                                                                                                                                                 |

The first pattern that matches wins, in the order of the table. The `initialize`
response lists slash commands shaped like 2.1.330's (`builtin` flags, "(user)" /
"(project)" description tags, a hidden `__internal`). The echo reply ends with
`[with N image(s): image/png, …]` when the message carried image blocks.
`claude auth status` prints `{"loggedIn": …}` (`FAKE_CLAUDE_LOGGED_OUT=1`: false, exit 1).

## fake-codex.mjs

It speaks `codex app-server`: JSON-RPC 2.0 over stdio, one object per line,
without the `"jsonrpc"` field. Notifications carry `emittedAtMs` and errors
look like `{error:{code,message}, id}`. The shapes follow
`codex app-server generate-ts` from codex-cli 0.171.0. The framing of
`initialize`, `thread/start`, `turn/start`, `turn/interrupt`, `thread/resume`
and `thread/turns/list` was checked against the real binary. Model turns could
not be checked, because there were no OpenAI credentials.

Implemented methods: `initialize`, `initialized`, `thread/start`,
`thread/resume`, `thread/turns/list`, `model/list`, `turn/start`,
`turn/interrupt` and `thread/list` (which returns an empty list). The fake
sends these requests to the client:
`item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
(decisions `accept`, `acceptForSession` or `decline`), and
`item/tool/requestUserInput`. After each answer, or on interrupt, it sends
`serverRequest/resolved`. Rollouts go to
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, using the real
`session_meta` and `response_item` records. Turns are kept in extra
`phonecode_fake_turn` lines so that resume can replay them.

Approval rules: with `never`, the fake never asks. Commands are asked about
under `untrusted` and `on-request`. File edits are asked about under
`untrusted`, and under `on-request` only when the sandbox is read-only.
`acceptForSession` lasts until the process exits.

| prompt contains       | what happens                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `close input`         | answers, then closes its stdin and keeps running                                                                       |
| `late ask`            | answers, then after `turn/completed` sends a `git fetch` command approval request                                      |
| `background decision` | reports the decision the host sent for that late request                                                               |
| `crash`               | streams a message, then exits with code 3                                                                              |
| `hello`               | streams an `agentMessage`                                                                                              |
| `think`               | reasoning summary deltas, then the answer                                                                              |
| `run tests`           | a `commandExecution` (`/bin/bash -lc 'npm test'`) with an approval request, streamed `outputDelta`, exit code 0        |
| `failing`             | a command that exits with code 2, with no approval                                                                     |
| `edit file`           | a `fileChange` (an add of `notes.md`, or an update with a unified diff) with an approval request, then writes the file |
| `ask me`              | `item/tool/requestUserInput` with 2 options                                                                            |
| `todo` / `plan`       | `turn/plan/updated` 4 times as the steps progress                                                                      |
| `search`              | a `webSearch` item and an `mcpToolCall` item                                                                           |
| `long`                | streams for about 10 s                                                                                                 |
| anything else         | `You said: …`                                                                                                          |

Every turn ends with `thread/tokenUsage/updated` and then `turn/completed`.

Also: `skills/list` (one user skill, `release-notes`), `thread/compact/start` (a
turn with one `contextCompaction` item), `codex login status`
(`FAKE_CODEX_LOGGED_OUT=1`: "Not logged in", exit 1). The echo reply lists the
images it got (`localImage png 1234b` when the file exists, or `image png`).
`skills/list` and `thread/compact/start` shapes were not checked against a real binary.

## fake-acp.mjs

It speaks the Agent Client Protocol (ACP v1): JSON-RPC 2.0 over stdio, one
object per line, with `"jsonrpc":"2.0"`, so it stands in for any ACP agent
(`gemini --acp`, `opencode acp`, …). Message shapes follow the stable v1 schema
shipped in `@agentclientprotocol/sdk` 2.8.0 (`schema/v1/schema.json`). Modes are
sent the way Gemini CLI 0.70.0 sends them (`modes` with `default`, `autoEdit`,
`yolo`, `plan`; changed with `session/set_mode`, confirmed with a
`current_mode_update`), and the model the way OpenCode 1.19.6 does (a
`configOptions` entry with `category: "model"`, changed with
`session/set_config_option`; `session/set_model` works too).

Two ways to select it:

- `PHONECODE_GEMINI_BIN=…/fake-acp.mjs` makes the built-in Gemini CLI preset
  launch the fake (`fake-acp.mjs --acp`). Any preset works the same way with
  `PHONECODE_<ID>_BIN`.
- an entry in `$PHONECODE_HOME/agents.json`, read when the daemon starts:
  `{"agents":[{"id":"my-agent","name":"My Agent","command":"/abs/path/fake-acp.mjs"}]}`.

Implemented methods: `initialize` (capabilities `loadSession`,
`sessionCapabilities.list/resume/close`, image and embedded-context prompts;
auth methods `fake-login`, `fake-api-key` and a `terminal` one), `authenticate`,
`session/new`, `session/load` (replays the stored history as `session/update`),
`session/resume`, `session/list`, `session/close`, `session/set_mode`,
`session/set_config_option`, `session/set_model`, `session/prompt` and the
`session/cancel` notification. Sessions are stored as JSON in
`$FAKE_ACP_HOME/sessions/` (default: a `fake-acp-home` folder in the temp dir).
The fake calls back into the client: `session/request_permission` (options
`allow_once`, `allow_always`, `reject_once`), `fs/read_text_file`,
`fs/write_text_file`, the `terminal/*` methods and `elicitation/create`
(form mode, shaped like Antigravity CLI 1.5.13's), each only when the client
advertised the capability. A prompt answers with `stopReason` `end_turn` or
`cancelled` plus `usage`, followed by a `usage_update` with a cost in USD.

"Always allow" lasts for the life of the process. Mode `yolo` never asks;
`autoEdit` does not ask for edits.

Environment: `FAKE_ACP_REQUIRE_AUTH=1` makes `session/new`, `load` and `resume`
fail with `-32000` (auth required) until `authenticate` succeeds, which it does
only for `fake-api-key` when `FAKE_ACP_API_KEY` is set (the adapter tries that
method by itself when an `*_API_KEY` variable is present).

| prompt contains       | what happens                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `close input`         | answers, then closes its stdin and keeps running                                                                                                                                                                        |
| `late ask`            | answers, then after the prompt's response asks `session/request_permission` for `git fetch`                                                                                                                             |
| `background decision` | reports the outcome the host sent for that late request                                                                                                                                                                 |
| `model error`         | answers `⚠ agent executor error: model unavailable (RESOURCE_EXHAUSTED)` and ends with `end_turn`, the way Antigravity reports a failed model call                                                                      |
| `ask me`              | a `Run ask_question` tool call, then `elicitation/create` naming it (`toolCallId`): a single choice with a `q1_other` free-text field, a multi-select array and a choice with `q3_other`. Answers `Received: <content>` |
| `crash`               | streams a few words, writes to stderr, exits with code 3 in the middle of the turn                                                                                                                                      |
| `hello`               | streams a short markdown answer word by word                                                                                                                                                                            |
| `think`               | `agent_thought_chunk`s, then the answer                                                                                                                                                                                 |
| `run tests`           | an `execute` tool call (`npm test`) with a permission request; if allowed, the output and a markdown table, if rejected the tool fails and the agent acknowledges                                                       |
| `failing`             | an `execute` tool call `ls ./does-not-exist` that fails with exit code 2, no permission needed                                                                                                                          |
| `edit file`           | reads `notes.md` in cwd through `fs/read_text_file`, sends an `edit` tool call with `diff` content (new file, or `hello world` → `hello phone-code` plus a line), asks, then writes it through `fs/write_text_file`     |
| `read outside`        | asks the client to read `/etc/hostname` (the adapter refuses: outside the session folder)                                                                                                                               |
| `terminal`            | asks, then runs `echo … && ls` through `terminal/create`, embeds the terminal in the tool call, waits for exit and releases it                                                                                          |
| `todo` / `plan`       | a `plan` update 4 times as 3 entries move from pending to in_progress to completed                                                                                                                                      |
| `search`              | a `search` tool call, a `fetch` tool call and a `think` tool call                                                                                                                                                       |
| `notice`              | a `notice` session update (only when the client advertised `session.notices`)                                                                                                                                           |
| `long`                | streams 100 words over about 10 s (for testing cancel)                                                                                                                                                                  |
| anything else         | `You said: …`                                                                                                                                                                                                           |

The first pattern that matches wins, in the order of the table.

`available_commands_update` (`init`, `help`, `review` with an input hint) follows
`session/new`, `load` and `resume`; a prompt starting with `/help` answers with the
list. The echo reply lists the image content blocks it got.

## fake-tailscale.mjs

Plays one state of the `tailscale` CLI, chosen with `FAKE_TAILSCALE_STATE`:
`ready` (default), `stopped`, `needs-login`, `starting`, `no-daemon`, `hang`
(`status` never answers), `no-magicdns`, `no-https`, `serve-disabled`. It
implements `version`, `status --json` and `serve <target>` (stays up until
SIGINT). Put it on PATH as `tailscale`, or point `PHONECODE_TAILSCALE_APP` at it
to play the macOS app's bundled CLI. Shapes follow Tailscale's documentation;
the real CLI was not available to check them.
