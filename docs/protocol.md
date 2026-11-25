# phone-code protocol

How the phone app and the `phonecode` daemon talk. The types in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) are the source of truth; the [reference](#reference) at the end of this page is generated from that file by `bun run docs:protocol`, and `bun run check` fails when it is out of date. The sections before it are written by hand.

Everything is JSON over HTTPS: a few HTTP endpoints for pairing, and one WebSocket for everything else.

## Transport

The daemon listens on `127.0.0.1` (port 7777 by default) and is reached through an HTTPS proxy: `tailscale serve`, a Cloudflare quick tunnel, or the user's own reverse proxy. `/api/*` and `/ws` reject a request unless it is a direct loopback connection or arrives from a loopback proxy that reports HTTPS (`X-Forwarded-Proto: https`, `Forwarded: proto=https` or Cloudflare's `CF-Visitor`). The rejection is HTTP 403 with a JSON `{error}`. `--insecure` disables this check.

## HTTP endpoints

| Method and path             | Auth                            | Body                               | Response                                                                                       |
| --------------------------- | ------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /api/pair`            | pairing or handoff code         | `PairRequest` `{code, deviceName}` | `PairResponse` `{deviceId, token, host}`; 401 for a bad or expired code, 429 when rate limited |
| `POST /api/handoff`         | `Authorization: Bearer <token>` | none                               | `HandoffResponse` `{code, expiresAt}`                                                          |
| `POST /api/unpair`          | `Authorization: Bearer <token>` | none                               | `{ok: true}`; the token stops working and its sockets close                                    |
| `GET /api/health`           | none                            | none                               | `{ok: true, version}`                                                                          |
| `GET /manifest.webmanifest` | none                            | none                               | the PWA manifest (its `start_url` can carry a handoff code)                                    |
| `GET /*`                    | none                            | none                               | the web app                                                                                    |

Request bodies are limited to 4 KB. Pairing codes are case-insensitive and ignore separators, so `k7qm-3xpa-9d` matches `K7QM3XPA9D`. The QR code encodes `<url>/#/pair?c=<code>`; the app redeems the code itself.

`/_control/*` is a separate local API for the `phonecode pair | devices | revoke` commands. It only accepts direct loopback requests without proxy headers that carry the secret from `control.json` in the state directory. It is not part of the client protocol.

## WebSocket session

1. Open `wss://<host>/ws`. Browsers must connect from the app's origin, the advertised URL, a loopback origin, or an origin in `PHONECODE_ALLOWED_ORIGINS`. Non-browser clients send no `Origin` and are allowed; the token is the authentication.
2. Within 5 seconds send `{"t":"hello","v":1,"token":"..."}`. Before `hello` succeeds, frames over 4 KB close the socket.
3. The daemon answers `ready` with `HostInfo`, then `sessions` (the full list, newest activity first). It sends `sessions` again on every change.
4. A wrong token closes the socket with code **4401** after an `error` frame with code `unauthorized`; a different protocol version closes it with **4400** (`version`). A revoked device is closed with 4401.
5. Either side may send at any time after that. `ping` is answered with `pong`; the app pings every 15 seconds and treats 40 seconds of silence as a dead link.

Only text frames are accepted. A frame may be at most 32 MB (photo attachments are base64 inside `chat.send`).

### Requests and responses

Messages that carry an `id` (`session.*`, `fs.list`, `history.list`, `chat.send`, `push.*`) are requests: the daemon answers each with exactly one `res` frame carrying the same `id`, either `{ok: true, data}` or `{ok: false, error}`. `RpcResults` in the reference maps each request to the type of `data`. Other client messages are fire-and-forget; a malformed one gets an `error` frame with code `bad_request`.

### Subscriptions, sequence numbers and replay

Session contents are streamed only to subscribers. `sub` answers with a snapshot (`chat.snapshot` or `term.snapshot`) carrying the session's current `seq`, followed by live events, each with the next `seq`.

- **Chat** transcripts are a list of `ChatItem`s with stable ids. `chat.item` inserts an item or replaces the one with the same id (new items go at the end); `chat.delta` appends text to a streaming `text` or `thinking` item. Applying events in `seq` order to the snapshot reproduces the daemon's transcript.
- **Terminals** send `term.snapshot` (an ANSI stream that redraws the screen and scrollback, produced by a headless xterm in a worker thread), then raw output in `term.data`, and `term.exit` when the process ends.

To resume after a dropped connection, send `sub` with `afterSeq` set to the last `seq` applied. The daemon replays the missed events from a bounded log (up to 4000 events or about 4 MB per session) or, if they have fallen out of it, sends a fresh snapshot. Clients must therefore accept a snapshot at any time and replace their state with it. A client that cannot keep up (more than about 1 MB buffered) is also resynchronized with a snapshot once its socket drains.

The ordering and replay rules are modeled in TLA+ in [`formal/ChatSync.tla`](../formal/ChatSync.tla).

### Notifications

After `ready`, a client that got a `vapidPublicKey` can register a Web Push subscription with `push.subscribe`. The daemon then sends a `PushPayload` when an agent finishes a turn or starts waiting for the user, while no client is subscribed to that session (at most one per session and reason every 5 seconds).

## Versioning

`PROTOCOL_VERSION` changes only for incompatible changes. Compatible additions are new optional fields and new message types; clients ignore unknown message types and fields, and fields marked "absent from older daemons" need a fallback.

## Reference

<!-- BEGIN GENERATED: bun scripts/protocol-doc.ts -->

Protocol version: **1** (`PROTOCOL_VERSION`).

### Client to daemon (`ClientMessage`)

| `t`                 | Fields                                                                              | Notes                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`             | `v: number; token: string`                                                          |                                                                                                                                                                                                                                             |
| `ping`              |                                                                                     |                                                                                                                                                                                                                                             |
| `session.create`    | `id: string; params: CreateSessionParams`                                           |                                                                                                                                                                                                                                             |
| `session.rename`    | `id: string; sessionId: string; title: string`                                      |                                                                                                                                                                                                                                             |
| `session.delete`    | `id: string; sessionId: string`                                                     | Kills the process and removes the session.                                                                                                                                                                                                  |
| `fs.list`           | `id: string; path?: string`                                                         | Directory listing for the "pick a folder" UI. Result: FsListResult                                                                                                                                                                          |
| `cursor.connect`    | `id: string`                                                                        | Installs (or removes) phone-code's hooks in Cursor's user hooks (~/.cursor/hooks.json, keeping every other hook). Answered with the new `HostInfo.cursor`.                                                                                  |
| `cursor.disconnect` | `id: string`                                                                        |                                                                                                                                                                                                                                             |
| `history.list`      | `id: string; agent?: AgentId; query?: HistoryQuery`                                 | Past agent sessions found on the host that can be resumed. Result: ResumableSession[] With `query` (even `{}`): "All chats", see HistoryQuery. Without it: the older resume picker (native agents only unless `agent` is given, newest 50). |
| `session.archive`   | `id: string; sessionId: string; archived: boolean`                                  | Hide a session from the sidebar (or bring it back). Result: SessionInfo                                                                                                                                                                     |
| `session.commands`  | `id: string; sessionId: string`                                                     | Slash commands available in a session right now. Result: SlashCommand[]                                                                                                                                                                     |
| `sub`               | `sessionId: string; afterSeq?: number`                                              |                                                                                                                                                                                                                                             |
| `unsub`             | `sessionId: string`                                                                 |                                                                                                                                                                                                                                             |
| `chat.send`         | `id: string; sessionId: string; text: string; attachments?: Attachment[]`           |                                                                                                                                                                                                                                             |
| `chat.interrupt`    | `sessionId: string`                                                                 |                                                                                                                                                                                                                                             |
| `chat.permission`   | `sessionId: string; itemId: string; decision: PermissionDecision; message?: string` |                                                                                                                                                                                                                                             |
| `chat.answer`       | `sessionId: string; itemId: string; answers: Record<string, string>`                |                                                                                                                                                                                                                                             |
| `chat.setMode`      | `sessionId: string; permissionMode: PermissionMode`                                 |                                                                                                                                                                                                                                             |
| `chat.setModel`     | `sessionId: string; model: string`                                                  |                                                                                                                                                                                                                                             |
| `chat.setEffort`    | `sessionId: string; effort: string`                                                 | Thinking level. Claude Code applies it at once, Codex from the next turn, ACP agents through their `thought_level` option. The session's `effort` follows.                                                                                  |
| `term.input`        | `sessionId: string; data: string`                                                   |                                                                                                                                                                                                                                             |
| `term.resize`       | `sessionId: string; cols: number; rows: number`                                     |                                                                                                                                                                                                                                             |
| `push.subscribe`    | `id: string; subscription: unknown`                                                 |                                                                                                                                                                                                                                             |
| `push.unsubscribe`  | `id: string; endpoint: string`                                                      |                                                                                                                                                                                                                                             |

### Daemon to client (`ServerMessage`)

| `t`             | Fields                                                                           | Notes                                                                                        |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ready`         | `v: number; host: HostInfo; deviceId: string; vapidPublicKey?: string`           |                                                                                              |
| `pong`          |                                                                                  |                                                                                              |
| `error`         | `code: ErrorCode; message: string`                                               |                                                                                              |
| `res`           | `id: string; ok: true; data?: unknown` or `id: string; ok: false; error: string` |                                                                                              |
| `sessions`      | `sessions: SessionInfo[]`                                                        | Full session list, sent after `ready` and on every change. Newest activity first.            |
| `chat.snapshot` | `sessionId: string; seq: number; items: ChatItem[]`                              |                                                                                              |
| `chat.item`     | `sessionId: string; seq: number; item: ChatItem`                                 |                                                                                              |
| `chat.delta`    | `sessionId: string; seq: number; itemId: string; text: string`                   |                                                                                              |
| `term.snapshot` | `sessionId: string; seq: number; cols: number; rows: number; data: string`       | `data` is an ANSI byte stream (as a string) that reproduces the current screen + scrollback. |
| `term.data`     | `sessionId: string; seq: number; data: string`                                   |                                                                                              |
| `term.exit`     | `sessionId: string; exitCode: number \| null`                                    |                                                                                              |

### Full type listing

Verbatim from `packages/protocol/src/index.ts`:

```ts
/**
 * phone-code wire protocol (v1).
 *
 * One WebSocket at `/ws` carries JSON text frames between the phone client and
 * the host daemon. This file is the single source of truth for both sides.
 *
 * Flow:
 *   1. Pairing (HTTP, once per device):  POST /api/pair {code, deviceName}
 *        -> {deviceId, token, host}
 *      The pairing code comes from the QR the daemon prints. Codes are
 *      single-use and expire.
 *   2. Connect: open /ws, send `hello` with the device token. The daemon
 *      answers `ready` (or `error` code "unauthorized" and closes).
 *   3. The daemon pushes `sessions` whenever the session list changes.
 *   4. The client subscribes to a session with `sub`. The daemon answers with a
 *      snapshot (`chat.snapshot` or `term.snapshot`) followed by live events.
 *      Reconnecting clients pass `afterSeq` to receive only what they missed
 *      (the daemon falls back to a full snapshot if it can no longer replay).
 *   5. Requests that need an answer carry `id`; the daemon replies with `res`.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- sessions

export type SessionKind = 'terminal' | 'agent';
/** Agents with a native (harness-specific) adapter in the daemon. */
export type AgentKind = 'claude' | 'codex';
/**
 * Any agent the host can run: a native `AgentKind`, or the stable id of an
 * agent driven through the Agent Client Protocol (ACP), e.g. "gemini",
 * "opencode" or an id from the host's `agents.json`. Ids are lowercase
 * `[a-z0-9._-]`, at most 64 characters.
 */
export type AgentId = AgentKind | (string & {});
/** How the daemon talks to an agent: its own adapter, or the generic ACP adapter. */
export type AgentImpl = 'native' | 'acp';

/** One agent the host offers (native or ACP-backed). */
export interface AgentInfo {
  id: AgentId;
  /** Display name, e.g. "Claude Code", "Gemini CLI". */
  name: string;
  impl: AgentImpl;
  /** Installed and runnable on this host. */
  available: boolean;
  version?: string;
  /** Models known before a session starts (ACP agents report theirs per session, see SessionInfo.models). */
  models?: string[];
  /** `models` with display names, same order. Absent from older daemons. */
  modelOptions?: ModelOption[];
  /**
   * Permission modes a new session of this agent can start in. Absent means
   * default, acceptEdits, plan and bypassPermissions.
   */
  permissionModes?: PermissionMode[];
  /** Built into phone-code, or defined by the user in `agents.json`. */
  source?: 'builtin' | 'config';
  /**
   * Why the agent is not usable and what to do about it, in one short line the
   * phone can show ("Not installed. Run: npm i -g @openai/codex", "Log in on
   * your computer: run `codex login`"). Absent when it is ready.
   */
  setupHint?: string;
  /** Slash commands known before a session exists (built-ins). See SlashCommand. */
  commands?: SlashCommand[];
}

/** A slash command the agent accepts as the start of a message ("/compact"). */
export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description?: string;
  /** Hint for arguments, e.g. "[instructions]". */
  argumentHint?: string;
  /** Where it comes from, for grouping: built into the agent, the project, the user, a plugin, an MCP server. */
  source?: 'builtin' | 'project' | 'user' | 'plugin' | 'mcp';
}

/**
 * idle     agent is waiting for the user's next message / shell is alive
 * running  agent is working on a turn
 * waiting  agent is blocked on the user (permission request or question)
 * exited   process ended normally (terminal) / session closed
 * error    process crashed or could not start
 */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'exited' | 'error';

/**
 * A model an agent offers. `id` is what `chat.setModel` / `CreateSessionParams.model`
 * take (an alias such as "opus" or a full model id); the rest is for display.
 */
export interface ModelOption {
  id: string;
  /** Display name, e.g. "Opus 4.7" or "Default (recommended)". */
  name?: string;
  /** One line under the name, e.g. "Best for everyday, complex tasks". */
  description?: string;
  /** The concrete model an alias currently stands for, e.g. "claude-opus-4-7". */
  resolved?: string;
  /** The model used when none is chosen. */
  isDefault?: boolean;
  /**
   * Thinking levels this model accepts (`chat.setEffort`, `CreateSessionParams.effort`),
   * lowest first. Absent when the model has no such setting (or the daemon is older).
   */
  efforts?: EffortOption[];
  /** The level the agent uses for this model when none is chosen. */
  defaultEffort?: string;
}

/**
 * A thinking level ("effort"): how long the agent reasons before acting.
 * `id` is the agent's own value ("low", "medium", "high", "xhigh", "max" for
 * Claude Code and Codex; whatever an ACP agent advertises).
 */
export interface EffortOption {
  id: string;
  /** Display name, e.g. "Extra high". */
  name?: string;
  /** One line under the name, e.g. "Greater reasoning depth for complex problems". */
  description?: string;
}

/**
 * How much the agent may do without asking. Mirrors Claude Code's modes.
 * `auto`: Claude Code decides per action with a safety classifier, asking only
 * for risky ones (Claude Code only; see SessionInfo.permissionModes).
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  /** Set when kind === 'agent'. */
  agent?: AgentId;
  /** Display name of `agent` (e.g. "Gemini CLI"). Absent from older daemons. */
  agentName?: string;
  title: string;
  cwd: string;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms, last activity
  status: SessionStatus;
  /** One-line preview of the latest activity (last assistant text, tool, or shell line). */
  preview?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /**
   * Permission modes this session's agent can actually switch to (ACP agents
   * advertise their own modes). Absent means the four that every agent had
   * before `auto`: default, acceptEdits, plan, bypassPermissions.
   */
  permissionModes?: PermissionMode[];
  /** Models this session's agent offers, when it reports them per session (Claude Code, ACP). */
  models?: string[];
  /** `models` with display names, same order. Absent from older daemons. */
  modelOptions?: ModelOption[];
  /** The thinking level in effect, when the agent reports one. */
  effort?: string;
  /**
   * Thinking levels this session can switch to, when they do not depend on the
   * model (ACP agents). Otherwise clients use the current model's
   * `ModelOption.efforts`.
   */
  efforts?: EffortOption[];
  /** True while there is activity the user has not seen (no subscriber when it happened). */
  unread?: boolean;
  /**
   * Archived sessions are hidden from the sidebar but keep their transcript and
   * can be found through `history.list`. Archiving stops the agent process;
   * sending a message (or `session.archive` with archived=false) brings the
   * session back. The `sessions` push includes archived sessions, flagged.
   */
  archived?: boolean;
}

/** Cursor's desktop app on the computer (see `HostInfo.cursor`). */
export interface CursorStatus {
  /** Cursor is installed (or its settings folder exists). */
  installed: boolean;
  /** phone-code's hooks are in Cursor's hooks.json. */
  connected: boolean;
}

export interface HostInfo {
  name: string; // hostname
  platform: string; // darwin | linux | win32
  user: string;
  home: string;
  daemonVersion: string;
  /** Which agent CLIs are installed and usable on this host. */
  agents: Array<{ kind: AgentKind; available: boolean; version?: string; models?: string[] }>;
  /**
   * Every agent the host can run, native ones first, then ACP-backed ones
   * (built-in presets found on PATH and entries from `agents.json`). Absent
   * from older daemons; clients then fall back to `agents`.
   */
  agentCatalog?: AgentInfo[];
  /**
   * Cursor's desktop app on this computer: whether it is there, and whether
   * phone-code's hooks are installed so its chats can be followed and answered
   * (`cursor.connect`). Absent from older daemons.
   */
  cursor?: CursorStatus;
  shell: string;
  /** How the phone reaches the host, so the app can say what works and what does not. */
  connection?: ConnectionInfo;
}

export interface ConnectionInfo {
  /**
   * tailscale  https through `tailscale serve`, private to the user's devices
   * tunnel     https through a public Cloudflare quick tunnel
   * url        the user's own https reverse proxy (--url)
   * lan        plain http on the local network (--insecure)
   * local      this computer only
   */
  mode: 'tailscale' | 'tunnel' | 'url' | 'lan' | 'local';
  /** True when the transport is encrypted (or loopback). */
  secure: boolean;
}

// -------------------------------------------------------------- chat items

/**
 * A chat transcript is an ordered list of items with stable ids. The daemon
 * mutates the transcript only through `chat.item` (insert-or-replace by id,
 * appended at the end if new) and `chat.delta` (append text to a streaming
 * text/thinking item). Every such event carries the session's next `seq`.
 */
export type ChatItem =
  | UserItem
  | TextItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | QuestionItem
  | NoticeItem
  | TurnItem;

interface ItemBase {
  id: string;
  ts: number; // epoch ms
}

export interface Attachment {
  /** e.g. image/png */
  mediaType: string;
  name?: string;
  /** base64 payload (no data: prefix) */
  data: string;
}

/**
 * An image stored by the daemon for a session. The bytes are fetched with
 * `GET /api/sessions/<sessionId>/images/<id>` (Authorization: Bearer <token>;
 * add `?w=<px>` for a downscaled thumbnail). Transcripts carry refs, never
 * the bytes.
 */
export interface ImageRef {
  id: string;
  mediaType: string;
  name?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface UserItem extends ItemBase {
  kind: 'user';
  text: string;
  /** @deprecated older daemons; newer ones send `images`. */
  attachments?: Array<Pick<Attachment, 'mediaType' | 'name'> & { data?: string }>;
  /** Images the user sent with this message. */
  images?: ImageRef[];
}

export interface TextItem extends ItemBase {
  kind: 'text';
  /** Markdown. */
  text: string;
  streaming: boolean;
  /** Images the agent produced or referenced in this message (e.g. local image files linked from the markdown). */
  images?: ImageRef[];
  /** What a sub-agent said: id of the Task tool item it runs under. Shown inside that card. */
  parentId?: string;
}

export interface ThinkingItem extends ItemBase {
  kind: 'thinking';
  text: string;
  streaming: boolean;
  /** A sub-agent's thinking: id of the Task tool item it runs under. */
  parentId?: string;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

/**
 * A tool call. `name` is normalized across agents so the client can render it
 * natively: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Todo,
 * Task (sub-agent), or the raw tool name for anything else (e.g. MCP tools).
 */
export interface ToolItem extends ItemBase {
  kind: 'tool';
  name: string;
  /** Short human title, e.g. "npm test", "src/app.ts", "Search: foo". */
  title: string;
  status: ToolStatus;
  /** Raw tool input as the agent sent it. */
  input?: unknown;
  /** Rich, pre-digested detail for native rendering. */
  detail?: ToolDetail;
  /** Text result, truncated by the daemon to a sane size. */
  output?: string;
  outputTruncated?: boolean;
  /** Images in the tool's input or result: a Read of an image file, a screenshot, an MCP image result. */
  images?: ImageRef[];
  /**
   * For sub-agent tool calls: id of the parent Task tool item. Also set (and
   * possibly only later) on an ACP tool call that a question card stands for:
   * then it is the QuestionItem's id and the row is not shown on its own.
   */
  parentId?: string;
}

export type ToolDetail =
  | {
      type: 'command';
      command: string;
      cwd?: string;
      exitCode?: number;
      /** Started to keep running after its call returned (a dev server, a watcher): `running` until it ends or is stopped. */
      background?: boolean;
    }
  | { type: 'diff'; path: string; /** unified diff text */ patch: string; added: number; removed: number }
  | { type: 'file'; path: string; /** for Write: new content (truncated) */ content?: string }
  | { type: 'todos'; todos: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'search'; query: string; path?: string }
  | { type: 'url'; url: string };

export type PermissionDecision = 'allow' | 'allowAlways' | 'deny';

/** The agent wants to run a tool and needs the user's approval. */
export interface PermissionItem extends ItemBase {
  kind: 'permission';
  toolName: string;
  title: string;
  input?: unknown;
  detail?: ToolDetail;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  /** Whether "always allow" is offered for this request. */
  canAllowAlways?: boolean;
  /**
   * False when the agent cannot receive a reason with a denial (ACP agents),
   * so "deny with feedback" is not offered. Absent means it can.
   */
  canDenyWithMessage?: boolean;
}

/** The agent asks the user a multiple-choice question. */
export interface QuestionItem extends ItemBase {
  kind: 'question';
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  status: 'pending' | 'answered' | 'cancelled';
  /** question text -> chosen label(s) or free text */
  answers?: Record<string, string>;
}

export interface NoticeItem extends ItemBase {
  kind: 'notice';
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Marks the end of an agent turn. */
export interface TurnItem extends ItemBase {
  kind: 'turn';
  outcome: 'completed' | 'interrupted' | 'error';
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens in the model's context after this turn, where the agent reports it. */
  contextTokens?: number;
  /** The size of the model's context window in tokens (with `contextTokens`: how full it is). */
  contextWindow?: number;
  error?: string;
}

// ------------------------------------------------------- client -> daemon

export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | { t: 'ping' }
  // --- rpc (all carry `id`, answered by `res`)
  | { t: 'session.create'; id: string; params: CreateSessionParams }
  | { t: 'session.rename'; id: string; sessionId: string; title: string }
  /** Kills the process and removes the session. */
  | { t: 'session.delete'; id: string; sessionId: string }
  /** Directory listing for the "pick a folder" UI. Result: FsListResult */
  | { t: 'fs.list'; id: string; path?: string }
  /**
   * Installs (or removes) phone-code's hooks in Cursor's user hooks
   * (~/.cursor/hooks.json, keeping every other hook). Answered with the new
   * `HostInfo.cursor`.
   */
  | { t: 'cursor.connect'; id: string }
  | { t: 'cursor.disconnect'; id: string }
  /**
   * Past agent sessions found on the host that can be resumed. Result: ResumableSession[]
   * With `query` (even `{}`): "All chats", see HistoryQuery. Without it: the
   * older resume picker (native agents only unless `agent` is given, newest 50).
   */
  | { t: 'history.list'; id: string; agent?: AgentId; query?: HistoryQuery }
  /** Hide a session from the sidebar (or bring it back). Result: SessionInfo */
  | { t: 'session.archive'; id: string; sessionId: string; archived: boolean }
  /** Slash commands available in a session right now. Result: SlashCommand[] */
  | { t: 'session.commands'; id: string; sessionId: string }
  // --- subscriptions
  | { t: 'sub'; sessionId: string; afterSeq?: number }
  | { t: 'unsub'; sessionId: string }
  // --- chat
  | { t: 'chat.send'; id: string; sessionId: string; text: string; attachments?: Attachment[] }
  | { t: 'chat.interrupt'; sessionId: string }
  | {
      t: 'chat.permission';
      sessionId: string;
      itemId: string;
      decision: PermissionDecision;
      message?: string;
    }
  | { t: 'chat.answer'; sessionId: string; itemId: string; answers: Record<string, string> }
  | { t: 'chat.setMode'; sessionId: string; permissionMode: PermissionMode }
  | { t: 'chat.setModel'; sessionId: string; model: string }
  /**
   * Thinking level. Claude Code applies it at once, Codex from the next turn, ACP agents
   * through their `thought_level` option. The session's `effort` follows.
   */
  | { t: 'chat.setEffort'; sessionId: string; effort: string }
  // --- terminal
  | { t: 'term.input'; sessionId: string; data: string }
  | { t: 'term.resize'; sessionId: string; cols: number; rows: number }
  // --- push notifications (Web Push)
  | { t: 'push.subscribe'; id: string; subscription: unknown }
  | { t: 'push.unsubscribe'; id: string; endpoint: string };

export interface CreateSessionParams {
  kind: SessionKind;
  agent?: AgentId;
  /** Defaults to the user's home directory. `~` is expanded by the daemon. */
  cwd?: string;
  title?: string;
  model?: string;
  /** Thinking level (an `EffortOption.id` of the model or session). */
  effort?: string;
  permissionMode?: PermissionMode;
  /** Resume a past agent session (id from `history.list`). */
  resumeId?: string;
  /** Terminal only: initial size. */
  cols?: number;
  rows?: number;
  /** Terminal only: run this instead of the login shell. */
  command?: string;
}

export interface FsListResult {
  path: string; // absolute, resolved
  parent?: string;
  entries: Array<{ name: string; dir: boolean; hidden: boolean }>;
}

export interface ResumableSession {
  agent: AgentId;
  resumeId: string;
  cwd: string;
  title: string; // first user prompt or summary
  updatedAt: number;
  messageCount?: number;
  /** Display name of `agent`. */
  agentName?: string;
  /**
   * Set when this conversation already is a phone-code session (in the sidebar
   * or archived): open that session instead of creating a new one. (A
   * `session.create` with this entry's resumeId also returns that session,
   * un-archived. For a phone-code session whose agent has not reported its own
   * id yet, resumeId is the phone-code session id.)
   */
  sessionId?: string;
  archived?: boolean;
  /** With a text query: a short excerpt around the first match. */
  snippet?: string;
}

/**
 * "All chats": every conversation the host knows about, from every harness,
 * whether it was started on the phone or at the computer, newest first.
 * Without `agent` on the request, all agents are searched (native and ACP).
 */
export interface HistoryQuery {
  /** Case-insensitive match on title, folder and message text. */
  text?: string;
  /** Only conversations in this folder (or below it). */
  cwd?: string;
  /** Default 50, max 200. */
  limit?: number;
  /** Opaque cursor from a previous result's last entry, for paging. */
  before?: number;
}

// ------------------------------------------------------- daemon -> client

export type ServerMessage =
  | { t: 'ready'; v: number; host: HostInfo; deviceId: string; vapidPublicKey?: string }
  | { t: 'pong' }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'res'; id: string; ok: true; data?: unknown }
  | { t: 'res'; id: string; ok: false; error: string }
  /** Full session list, sent after `ready` and on every change. Newest activity first. */
  | { t: 'sessions'; sessions: SessionInfo[] }
  // --- chat
  | { t: 'chat.snapshot'; sessionId: string; seq: number; items: ChatItem[] }
  | { t: 'chat.item'; sessionId: string; seq: number; item: ChatItem }
  | { t: 'chat.delta'; sessionId: string; seq: number; itemId: string; text: string }
  // --- terminal
  /** `data` is an ANSI byte stream (as a string) that reproduces the current screen + scrollback. */
  | { t: 'term.snapshot'; sessionId: string; seq: number; cols: number; rows: number; data: string }
  | { t: 'term.data'; sessionId: string; seq: number; data: string }
  | { t: 'term.exit'; sessionId: string; exitCode: number | null };

export type ErrorCode = 'unauthorized' | 'bad_request' | 'not_found' | 'version' | 'internal';

// ------------------------------------------------------------------- HTTP

export interface PairRequest {
  code: string;
  deviceName: string;
}
export interface PairResponse {
  deviceId: string;
  token: string;
  host: Pick<HostInfo, 'name' | 'platform' | 'user'>;
}

/**
 * Handoff: iOS gives a Home Screen web app its own storage, separate from
 * Safari where the QR was scanned. A paired client can mint a short-lived,
 * single-use handoff code (POST /api/handoff with `Authorization: Bearer
 * <token>` -> {code}) and put it in the URL / manifest start_url; the freshly
 * installed app redeems it via POST /api/pair like a pairing code.
 */
export interface HandoffResponse {
  code: string;
  expiresAt: number;
}

/*
 * Unpair: POST /api/unpair with `Authorization: Bearer <token>` -> {ok: true}.
 * The daemon forgets the device: its token stops working and its open
 * websockets are closed.
 */

/** Result type helpers for rpc calls. */
export interface RpcResults {
  'session.create': SessionInfo;
  'session.rename': SessionInfo;
  'session.delete': undefined;
  'fs.list': FsListResult;
  'history.list': ResumableSession[];
  'session.archive': SessionInfo;
  'session.commands': SlashCommand[];
  'chat.send': { itemId: string };
  'push.subscribe': undefined;
  'push.unsubscribe': undefined;
  'cursor.connect': CursorStatus;
  'cursor.disconnect': CursorStatus;
}

/**
 * JSON body of a Web Push message sent by the daemon. The client's service
 * worker shows it as a notification; tapping it opens `sessionId`.
 */
export interface PushPayload {
  title: string;
  body?: string;
  sessionId?: string;
  /** Notifications with the same tag replace each other (e.g. the session id). */
  tag?: string;
}
```

<!-- END GENERATED -->
