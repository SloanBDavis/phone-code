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
}

export interface ThinkingItem extends ItemBase {
  kind: 'thinking';
  text: string;
  streaming: boolean;
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
  | { type: 'command'; command: string; cwd?: string; exitCode?: number }
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
