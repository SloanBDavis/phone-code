/**
 * Contract between the daemon core (session manager, websocket server) and the
 * agent adapters (Claude Code, Codex). The core owns transcripts, seq numbers,
 * persistence and fan-out to clients; an adapter owns one agent process and
 * translates its native event stream into ChatItems.
 */
import type {
  AgentKind,
  Attachment,
  ChatItem,
  PermissionDecision,
  PermissionMode,
  ResumableSession,
  SessionStatus,
} from '@phone-code/protocol';

export interface AgentStartOptions {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Native session id to resume (from listResumable or a previous run's onNativeSessionId). */
  resumeId?: string;
  env?: NodeJS.ProcessEnv;
}

/** Callbacks the core hands to an adapter. All are safe to call at any time. */
export interface AgentEvents {
  /** Insert a new item or replace the existing item with the same id. */
  upsert(item: ChatItem): void;
  /** Append text to a streaming `text` / `thinking` item previously upserted. */
  delta(itemId: string, text: string): void;
  status(status: SessionStatus): void;
  /** The agent's own session id became known (needed to resume after a daemon restart). */
  nativeSessionId(id: string): void;
  /** Model / mode actually in effect changed. */
  meta(meta: { model?: string; permissionMode?: PermissionMode; title?: string }): void;
}

/** One live agent conversation. */
export interface AgentSession {
  /** Send a user message. The core has already added the UserItem to the transcript. */
  send(text: string, attachments?: Attachment[]): Promise<void>;
  /** Stop the current turn (like pressing Esc in the TUI). */
  interrupt(): Promise<void>;
  /** Answer a PermissionItem the adapter upserted. The adapter upserts its new status. */
  resolvePermission(itemId: string, decision: PermissionDecision, message?: string): void;
  /** Answer a QuestionItem the adapter upserted. The adapter upserts its new status. */
  answerQuestion(itemId: string, answers: Record<string, string>): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  /** Kill the process and release resources. */
  dispose(): Promise<void>;
}

export interface AgentAdapter {
  kind: AgentKind;
  /** Is the CLI installed? Cheap; called at startup and cached. */
  detect(): Promise<{ available: boolean; version?: string; models?: string[] }>;
  /**
   * Start (or resume) a conversation. Must not throw for "CLI missing" style
   * problems after returning; report those via a NoticeItem + status('error').
   * When resuming, the adapter should upsert the past transcript first so the
   * phone shows the earlier conversation.
   */
  start(opts: AgentStartOptions, events: AgentEvents): Promise<AgentSession>;
  /** Past sessions on this host that can be resumed, newest first. */
  listResumable(limit?: number): Promise<ResumableSession[]>;
}

/**
 * Adapters are looked up through this registry. `PHONECODE_CLAUDE_BIN` and
 * `PHONECODE_CODEX_BIN` override the binaries (the e2e suite points them at
 * scripted fake agents).
 */
export type AdapterRegistry = Record<AgentKind, AgentAdapter>;
