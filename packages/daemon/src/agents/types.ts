/**
 * Contract between the daemon core (session manager, websocket server) and the
 * agent harnesses (Claude Code, Codex, ACP agents, Cursor's app). The core owns
 * transcripts, seq numbers, persistence and fan-out to clients; an adapter owns
 * one agent process and translates its native event stream into ChatItems.
 *
 * Everything the core needs to know about a harness is on its AgentAdapter:
 * the core never checks for a particular agent id. See agents/README.md for
 * adding one.
 */
import type { Conversation, FileStat } from '../history/index-file.ts';
import type {
  AgentId,
  AgentImpl,
  Attachment,
  ChatItem,
  EffortOption,
  ImageRef,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  ResumableSession,
  SessionStatus,
  SlashCommand,
} from '@phone-code/protocol';

/**
 * What an adapter receives for each thing the user attached. Images were
 * stored and sniffed by the core first: `mediaType` is the real type, `data`
 * the base64 bytes, `path` the stored file (for agents that take local files)
 * and `ref` the ImageRef shown in the transcript.
 */
export type AgentAttachment = Attachment & { path?: string; ref?: ImageRef };

export interface AgentStartOptions {
  cwd: string;
  model?: string;
  /** Thinking level (EffortOption.id) to start with. */
  effort?: string;
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
  meta(meta: {
    model?: string;
    permissionMode?: PermissionMode;
    title?: string;
    /** Models the agent offers for this session (ACP agents report them per session). */
    models?: string[];
    /** `models` with display names, same order. */
    modelOptions?: ModelOption[];
    /** Thinking level in effect. */
    effort?: string;
    /** Thinking levels for this session when they do not depend on the model (ACP); [] clears. */
    efforts?: EffortOption[];
    /** Permission modes the agent can switch to (absent: all four). */
    permissionModes?: PermissionMode[];
    /** Slash commands the agent accepts in this session (replaces the previous list). */
    commands?: SlashCommand[];
  }): void;
  /**
   * Store an image the agent produced (base64 or raw bytes) in the session's
   * image store and get its ref. Synchronous; undefined when the bytes are
   * not a PNG/JPEG/GIF/WebP or over a size cap.
   */
  image(data: string | Uint8Array, name?: string): ImageRef | undefined;
  /**
   * Store a local image file the agent referenced, if its real path is inside
   * the session folder or the agent's artifact directories (images/markdown.ts).
   */
  imageFile(path: string, name?: string): Promise<ImageRef | undefined>;
}

/** One live agent conversation. */
export interface AgentSession {
  /** Send a user message. The core has already added the UserItem to the transcript. */
  send(text: string, attachments?: AgentAttachment[]): Promise<void>;
  /** Stop the current turn (like pressing Esc in the TUI). */
  interrupt(): Promise<void>;
  /** Answer a PermissionItem the adapter upserted. The adapter upserts its new status. */
  resolvePermission(itemId: string, decision: PermissionDecision, message?: string): void;
  /** Answer a QuestionItem the adapter upserted. The adapter upserts its new status. */
  answerQuestion(itemId: string, answers: Record<string, string>): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  /** Change the thinking level. Absent: the agent has no such setting. */
  setEffort?(effort: string): Promise<void>;
  /** Kill the process and release resources. */
  dispose(): Promise<void>;
}

/**
 * A harness's own conversation files on this host, indexed for "All chats"
 * (history/service.ts) so text search covers whole conversations. Harnesses
 * without one are listed through `listResumable` instead.
 */
export interface HarnessHistory {
  /** Every conversation file, with size and mtime (only changed files are read again). */
  list(): Promise<FileStat[]>;
  /** Title, folder, resume id and text of one file; undefined skips it (sub-agents, empty files). */
  extract(file: FileStat): Promise<Conversation | undefined>;
}

export interface AgentAdapter {
  /** The agent id ("claude", "gemini"): lowercase [a-z0-9._-], unique on the host. */
  kind: AgentId;
  /** Display name ("Claude Code", "Gemini CLI"). */
  name: string;
  /** Name where space is short ("Claude"). Absent: `name`. */
  shortName?: string;
  /** Two letters for its glyph ("CC"). Absent: the phone uses the id's first two. */
  monogram?: string;
  /** 'native' when omitted. */
  impl?: AgentImpl;
  /**
   * Its chats start outside phone-code (Cursor's app, followed through hooks):
   * not offered for new chats, never started by phone-code.
   */
  external?: boolean;
  /** Where an ACP agent's entry comes from. */
  source?: 'builtin' | 'config';
  /** Is the CLI installed? Cheap; called at startup and cached. */
  detect(): Promise<{
    available: boolean;
    version?: string;
    models?: string[];
    /** `models` with display names. */
    modelOptions?: ModelOption[];
    /** Permission modes the agent accepts (absent: default, acceptEdits, plan, bypassPermissions). */
    permissionModes?: PermissionMode[];
    /** Slash commands known without a session (see AgentInfo.commands). */
    commands?: SlashCommand[];
    /** Why the agent is not usable and what to do (see AgentInfo.setupHint). */
    setupHint?: string;
  }>;
  /**
   * Start (or resume) a conversation. Must not throw for "CLI missing" style
   * problems after returning; report those via a NoticeItem + status('error').
   * When resuming, the adapter should upsert the past transcript first so the
   * phone shows the earlier conversation.
   */
  start(opts: AgentStartOptions, events: AgentEvents): Promise<AgentSession>;
  /** Past sessions on this host that can be resumed, newest first. */
  listResumable(limit?: number): Promise<ResumableSession[]>;
  /** Its conversation files, for "All chats" search (see HarnessHistory). */
  history?: HarnessHistory;
  /**
   * Folders it writes generated images to, besides the session folder; images
   * it links to there are shown in the chat (images/markdown.ts).
   */
  artifactRoots?(env?: NodeJS.ProcessEnv): string[];
}

/**
 * Adapters are looked up through this registry, by agent id, in the order the
 * phone lists them (agents/index.ts builds it). `PHONECODE_CLAUDE_BIN` and
 * `PHONECODE_CODEX_BIN` override the native binaries (the e2e suite points
 * them at scripted fake agents); see acp/config.ts for the ACP agents.
 */
export type AdapterRegistry = Partial<Record<AgentId, AgentAdapter>>;

/** Display name of an agent id, from its adapter when known. */
export function agentDisplayName(adapters: AdapterRegistry, id: AgentId): string {
  return adapters[id]?.name ?? id;
}

/** All adapters, in registry order. */
export function listAdapters(adapters: AdapterRegistry): AgentAdapter[] {
  return Object.values(adapters).filter((a): a is AgentAdapter => a !== undefined);
}
