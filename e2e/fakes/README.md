# Fake agents for the e2e suite

Two executable, dependency-free scripts that stand in for the real CLIs. The
adapters in `packages/daemon/src/agents/` cannot tell them from the real
binaries. Point the daemon at them with:

```sh
PHONECODE_CLAUDE_BIN=$PWD/e2e/fakes/fake-claude.mjs \
PHONECODE_CODEX_BIN=$PWD/e2e/fakes/fake-codex.mjs \
CLAUDE_CONFIG_DIR=/tmp/fake-claude-home \
CODEX_HOME=/tmp/fake-codex-home \
bun packages/daemon/src/cli.ts
```

Both scripts start with `#!/usr/bin/env bun` and also run under node.
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
  (followed by `system/status` carrying `permissionMode`) and `set_model`.
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
  the replay of past turns and `listResumable` all work.

A rule saved with "always allow" (an `addRules` suggestion) lasts for the life
of the process. A `setMode` update changes the mode, as in the real CLI.

| prompt contains  | what happens                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crash`          | streams a few words, writes to stderr, exits with code 3 in the middle of the turn                                                                                                                                                            |
| `hello`          | streams a short markdown answer word by word                                                                                                                                                                                                  |
| `think`          | streams a thinking block, then the answer                                                                                                                                                                                                     |
| `run tests`      | sends text, then `Bash npm test` and asks for permission (unless always-allowed or the mode is `bypassPermissions`). If allowed: test output, then a markdown table. If denied: an acknowledgement                                            |
| `failing`        | runs `Bash ls ./does-not-exist`, which fails with `Exit code 2` (no permission needed)                                                                                                                                                        |
| `edit file`      | creates `notes.md` in cwd with `Write`, or changes it with `Edit` if it exists (`hello world` becomes `hello phone-code` plus one line). Asks for permission unless the mode is `acceptEdits` or `bypassPermissions`. The file really changes |
| `ask me`         | an `AskUserQuestion` with 2 options. The answer comes back in `updatedInput.answers`                                                                                                                                                          |
| `todo`           | `TodoWrite` 4 times as 3 items move from pending to in_progress to completed (about 0.5 s apart)                                                                                                                                              |
| `agent` / `task` | a `Task` tool whose sub-agent runs `Bash ls`. Those messages carry `parent_tool_use_id`                                                                                                                                                       |
| `plan`           | `ExitPlanMode` with a markdown plan. Allowing it applies the host's `setMode`                                                                                                                                                                 |
| `long`           | streams 100 words over about 10 s (for testing interrupt)                                                                                                                                                                                     |
| `compact`        | `status: compacting`, then a `compact_boundary`                                                                                                                                                                                               |
| `rate limit`     | an `allowed_warning` `rate_limit_event` and an `api_retry`                                                                                                                                                                                    |
| anything else    | `You said: …`                                                                                                                                                                                                                                 |

The first pattern that matches wins, in the order of the table.

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

| prompt contains | what happens                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `crash`         | streams a message, then exits with code 3                                                                              |
| `hello`         | streams an `agentMessage`                                                                                              |
| `think`         | reasoning summary deltas, then the answer                                                                              |
| `run tests`     | a `commandExecution` (`/bin/bash -lc 'npm test'`) with an approval request, streamed `outputDelta`, exit code 0        |
| `failing`       | a command that exits with code 2, with no approval                                                                     |
| `edit file`     | a `fileChange` (an add of `notes.md`, or an update with a unified diff) with an approval request, then writes the file |
| `ask me`        | `item/tool/requestUserInput` with 2 options                                                                            |
| `todo` / `plan` | `turn/plan/updated` 4 times as the steps progress                                                                      |
| `search`        | a `webSearch` item and an `mcpToolCall` item                                                                           |
| `long`          | streams for about 10 s                                                                                                 |
| anything else   | `You said: …`                                                                                                          |

Every turn ends with `thread/tokenUsage/updated` and then `turn/completed`.
