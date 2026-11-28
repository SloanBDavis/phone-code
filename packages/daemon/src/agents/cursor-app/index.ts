/**
 * Cursor's desktop app, followed through its agent hooks.
 *
 * Cursor has no API into its app's chats, but it runs hooks (~/.cursor/hooks.json)
 * at each step of an agent turn. phone-code installs a small script as those hooks
 * (cursor/hooks.ts); the script posts every event here (`/_control/cursor/<event>`).
 * Each Cursor conversation becomes a phone-code chat (agent "cursor-app",
 * keyed by Cursor's conversation_id):
 *
 *   beforeSubmitPrompt -> UserItem          afterAgentResponse -> TextItem
 *   afterAgentThought  -> ThinkingItem      postToolUse        -> ToolItem
 *   afterFileEdit      -> ToolItem (diff)   stop / sessionEnd  -> TurnItem, idle
 *
 * Replying: Cursor's `stop` hook may return a `followup_message`, which Cursor
 * submits as the next message of that same chat; nothing else can put a message
 * into a Cursor chat. A message sent from the phone while Cursor works waits for
 * that hook. When a turn ends the hook is held open for a reply (the chat is
 * `waiting`) if a device has the chat open, or if nobody is at the computer (no
 * keyboard or mouse input for `awayMs`) and a device is paired. It is let go
 * when someone is back at the computer and no device has the chat open, so the
 * desktop is not held up for whoever sits at it, and after `holdMs` at the latest.
 * Once let go, the chat is `idle` and takes no message until the next turn.
 */
import { homedir } from 'node:os';
import type { ChatItem, ToolItem } from '@phone-code/protocol';
import { log } from '../../log.ts';
import type { SessionManager } from '../../sessions/manager.ts';
import { ChatSession } from '../../sessions/chat.ts';
import { cursorInstalled } from '../../cursor/hooks.ts';
import { computerIdleMs } from '../../cursor/idle.ts';
import { isRec, oneLine, str, type Rec } from '../shared/common.ts';
import { countPatch, unifiedDiff } from '../shared/diff.ts';
import type { AgentAdapter, AgentEvents, AgentSession, AgentStartOptions } from '../types.ts';

export const CURSOR_APP = 'cursor-app';

/** The longest a finished turn waits for a reply (cursor/hooks.ts gives the hook a little more). */
export const DEFAULT_HOLD_MS = 8 * 60 * 60_000;
/** No keyboard or mouse input for this long: nobody is at the computer. */
const DEFAULT_AWAY_MS = 2 * 60_000;
/** How often a waiting turn checks whether someone is back at the computer. */
const DEFAULT_POLL_MS = 3000;
/** Where idle time is unknown: a turn nobody has open any more is let go after this. */
const UNFOLLOWED_MS = 10 * 60_000;

export interface CursorBridgeOptions {
  holdMs?: number;
  awayMs?: number;
  pollMs?: number;
  /** Milliseconds since the last keyboard or mouse input; `undefined` when unknown. */
  idleMs?: () => Promise<number | undefined>;
  /** Whether any device is paired (someone could reply from one). */
  hasDevices?: () => boolean;
}

const envMs = (name: string): number | undefined => {
  const n = Number(process.env[name]);
  return n > 0 ? n : undefined;
};

interface Conversation {
  events?: AgentEvents;
  /** Replies from the phone not yet handed to Cursor. */
  queued: string[];
  /** A `stop` hook waiting for a reply. */
  waiter?: (reply: string | undefined) => void;
  /** Text handed to Cursor as a follow-up: its beforeSubmitPrompt is not a new user message. */
  delivered?: string;
  turnStartedAt?: number;
  /** Cursor is in a turn: a message from the phone goes out when it ends. */
  running?: boolean;
  seq: number;
  /** Called when a session attaches (its adapter started). */
  onAttach?: () => void;
}

export class CursorBridge {
  private manager: SessionManager | undefined;
  private readonly conversations = new Map<string, Conversation>();
  readonly holdMs: number;
  private readonly awayMs: number;
  private readonly pollMs: number;
  private readonly idleMs: () => Promise<number | undefined>;
  private readonly hasDevices: () => boolean;

  constructor(opts: CursorBridgeOptions = {}) {
    this.holdMs = opts.holdMs ?? envMs('PHONECODE_CURSOR_HOLD_MS') ?? DEFAULT_HOLD_MS;
    this.awayMs = opts.awayMs ?? envMs('PHONECODE_CURSOR_AWAY_MS') ?? DEFAULT_AWAY_MS;
    this.pollMs = opts.pollMs ?? envMs('PHONECODE_CURSOR_POLL_MS') ?? DEFAULT_POLL_MS;
    this.idleMs = opts.idleMs ?? computerIdleMs;
    this.hasDevices = opts.hasDevices ?? (() => false);
  }

  attachManager(manager: SessionManager): void {
    this.manager = manager;
  }

  private conv(id: string): Conversation {
    let c = this.conversations.get(id);
    if (c === undefined) {
      c = { queued: [], seq: 0 };
      this.conversations.set(id, c);
    }
    return c;
  }

  /** The adapter that ChatSession drives; `start` attaches a session to its conversation. */
  adapter(): AgentAdapter {
    return {
      kind: CURSOR_APP,
      name: 'Cursor',
      external: true,
      detect: async () => ({ available: await cursorInstalled(), permissionModes: [] }),
      start: async (opts: AgentStartOptions, events: AgentEvents): Promise<AgentSession> => {
        const id = opts.resumeId;
        if (id === undefined) throw new Error('Cursor chats start in the Cursor app.');
        const c = this.conv(id);
        c.events = events;
        c.onAttach?.();
        delete c.onAttach;
        events.nativeSessionId(id);
        events.meta({ permissionModes: [] });
        events.status(c.waiter === undefined ? 'idle' : 'waiting');
        return this.session(id);
      },
      listResumable: async () => [],
    };
  }

  private session(id: string): AgentSession {
    return {
      send: async (text) => this.reply(id, text),
      interrupt: async () => {
        this.notice(id, 'info', 'Stop it in the Cursor app: phone-code can only follow and reply.');
      },
      resolvePermission: () => {},
      answerQuestion: () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      dispose: async () => {
        const c = this.conversations.get(id);
        if (c !== undefined) delete c.events;
      },
    };
  }

  /** A message from the phone: to the waiting `stop` hook, or held until the running turn ends. */
  private reply(id: string, text: string): void {
    const c = this.conv(id);
    if (c.waiter !== undefined) {
      c.waiter(text);
      return;
    }
    if (c.running === true) {
      c.queued.push(text);
      c.events?.status('running');
      this.notice(id, 'info', 'Cursor gets this message when its current turn ends.', 'queued');
      return;
    }
    // No turn to end and no hook waiting: there is no way to hand Cursor a message.
    c.events?.status('idle');
    this.notice(
      id,
      'warn',
      'Not sent: Cursor is no longer waiting for a reply in this chat. Send its next message from Cursor on your computer; you can reply here when that turn ends.',
      'closed',
    );
  }

  private notice(id: string, level: 'info' | 'warn', text: string, key?: string): void {
    const c = this.conv(id);
    c.seq += 1;
    c.events?.upsert({ kind: 'notice', id: `cursor-notice:${key ?? c.seq}`, ts: Date.now(), level, text });
  }

  /** One hook call from Cursor. Returns the JSON the hook prints back to Cursor. */
  async handle(event: string, input: Rec, request?: { signal: AbortSignal }): Promise<Rec> {
    const id = str(input.conversation_id);
    if (id === undefined || this.manager === undefined) return {};
    const c = this.conv(id);
    await this.ensureSession(id, input);
    const ev = c.events;
    const now = Date.now();
    const gen = str(input.generation_id) ?? String(now);
    const up = (item: ChatItem): void => ev?.upsert(item);
    if (event !== 'stop' && event !== 'sessionEnd') c.running = true;
    switch (event) {
      case 'beforeSubmitPrompt': {
        const prompt = str(input.prompt) ?? '';
        c.turnStartedAt = now;
        // A new message went in at the computer: nothing waits for the phone any more.
        c.waiter?.(undefined);
        ev?.status('running');
        if (c.delivered !== undefined && c.delivered.trim() === prompt.trim()) {
          // Our own follow-up coming back: the phone already shows it.
          delete c.delivered;
          return {};
        }
        if (prompt.trim() !== '') {
          up({ kind: 'user', id: `cursor-user:${gen}`, ts: now, text: prompt });
          ev?.meta({ title: oneLine(prompt, 60) });
        }
        return {};
      }
      case 'afterAgentThought': {
        const text = str(input.text);
        if (text)
          up({ kind: 'thinking', id: `cursor-think:${gen}:${++c.seq}`, ts: now, text, streaming: false });
        return {};
      }
      case 'afterAgentResponse': {
        const text = str(input.text);
        if (text) up({ kind: 'text', id: `cursor-text:${gen}:${++c.seq}`, ts: now, text, streaming: false });
        return {};
      }
      case 'postToolUse':
      case 'postToolUseFailure': {
        const tool = toolItem(input, event === 'postToolUseFailure', now);
        if (tool) up(tool);
        return {};
      }
      case 'afterFileEdit': {
        const tool = fileEditItem(input, now, ++c.seq);
        if (tool) up(tool);
        return {};
      }
      case 'stop':
        return this.stop(id, c, input, request?.signal);
      case 'sessionEnd':
        c.running = false;
        c.waiter?.(undefined);
        ev?.status('idle');
        return {};
      default:
        return {};
    }
  }

  private async stop(id: string, c: Conversation, input: Rec, signal: AbortSignal | undefined): Promise<Rec> {
    const status = str(input.status);
    const ev = c.events;
    const ended = Date.now();
    c.running = false;
    const turn: ChatItem = {
      kind: 'turn',
      id: `cursor-turn:${str(input.generation_id) ?? ended}`,
      ts: ended,
      outcome: status === 'completed' ? 'completed' : status === 'aborted' ? 'interrupted' : 'error',
      ...(c.turnStartedAt === undefined ? {} : { durationMs: ended - c.turnStartedAt }),
    };
    // Replies sent while Cursor worked go out now.
    if (c.queued.length > 0) {
      ev?.upsert(turn);
      return this.followUp(c, c.queued.splice(0).join('\n\n'));
    }
    if (status !== 'completed' || !(await this.shouldWait(id))) {
      ev?.upsert(turn);
      ev?.status('idle');
      return {};
    }
    // Wait for a reply (the desktop shows Cursor still finishing). `waiting` first:
    // the notification for a chat nobody has open then says a reply is wanted.
    ev?.status('waiting');
    ev?.upsert(turn);
    const reply = await new Promise<string | undefined>((resolve) => {
      let lastFollowed = Date.now();
      const done = (r: string | undefined): void => {
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener('abort', aborted);
        if (c.waiter === done) delete c.waiter;
        resolve(r);
      };
      const aborted = (): void => done(undefined);
      const timer = setTimeout(() => done(undefined), this.holdMs);
      // Someone is back at the computer and no device has the chat open: let Cursor go.
      const check = async (): Promise<void> => {
        const idle = await this.idleMs();
        if (c.waiter !== done || this.followed(id)) return;
        const back = idle === undefined ? Date.now() - lastFollowed > UNFOLLOWED_MS : idle < this.awayMs;
        if (back) done(undefined);
      };
      const poll = setInterval(() => {
        if (this.followed(id)) lastFollowed = Date.now();
        else void check();
      }, this.pollMs);
      signal?.addEventListener('abort', aborted);
      c.waiter = done;
    });
    if (reply === undefined) {
      ev?.status('idle');
      return {};
    }
    return this.followUp(c, reply);
  }

  /** Whether a finished turn waits for a reply: a device has the chat open, or nobody is at the computer. */
  private async shouldWait(id: string): Promise<boolean> {
    if (this.followed(id)) return true;
    if (!this.hasDevices()) return false;
    const idle = await this.idleMs();
    return idle !== undefined && idle >= this.awayMs;
  }

  private followUp(c: Conversation, text: string): Rec {
    c.delivered = text;
    c.running = true;
    c.events?.status('running');
    return { followup_message: text };
  }

  private followed(id: string): boolean {
    const s = this.sessionFor(id);
    return s?.hasSubscribers() === true;
  }

  private sessionFor(id: string): ChatSession | undefined {
    for (const s of this.manager?.list() ?? []) {
      if (s.agent !== CURSOR_APP) continue;
      const live = this.manager?.get(s.id);
      if (live instanceof ChatSession && live.nativeId === id) return live;
    }
    return undefined;
  }

  /** The phone-code chat for a Cursor conversation, created on its first event. */
  private async ensureSession(id: string, input: Rec): Promise<void> {
    const c = this.conv(id);
    if (c.events !== undefined || this.manager === undefined) return;
    const roots = Array.isArray(input.workspace_roots)
      ? input.workspace_roots.filter((r) => typeof r === 'string')
      : [];
    // The adapter attaches when the new session starts its agent.
    const attached = new Promise<void>((resolve) => {
      c.onAttach = resolve;
      setTimeout(resolve, 2000);
    });
    try {
      await this.manager.create({
        kind: 'agent',
        agent: CURSOR_APP,
        cwd: roots[0] ?? homedir(),
        resumeId: id,
        ...(typeof input.prompt === 'string' ? { title: oneLine(input.prompt, 60) } : {}),
      });
      await attached;
    } catch (e) {
      log.warn('could not follow a Cursor chat', e);
    }
  }
}

const TOOL_NAMES: Record<string, string> = {
  Shell: 'Bash',
  run_terminal_cmd: 'Bash',
  Read: 'Read',
  read_file: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  search_replace: 'Edit',
  Grep: 'Grep',
  grep: 'Grep',
  Glob: 'Glob',
  WebSearch: 'WebSearch',
  WebFetch: 'WebFetch',
};

function toolItem(input: Rec, failed: boolean, now: number): ToolItem | undefined {
  const raw = str(input.tool_name);
  if (!raw) return undefined;
  const name = TOOL_NAMES[raw] ?? raw;
  const args = isRec(input.tool_input) ? input.tool_input : {};
  const command = str(args.command);
  const path = str(args.file_path) ?? str(args.path) ?? str(args.target_file);
  const output = failed ? str(input.error_message) : str(input.tool_output);
  const item: ToolItem = {
    kind: 'tool',
    id: `cursor-tool:${str(input.tool_use_id) ?? now}`,
    ts: now,
    name,
    title: command ?? path ?? str(args.query) ?? str(args.pattern) ?? raw,
    status: failed ? 'error' : 'done',
    input: args,
    ...(command
      ? { detail: { type: 'command' as const, command, ...(str(input.cwd) ? { cwd: str(input.cwd) } : {}) } }
      : {}),
    ...(output
      ? {
          output: output.length > 20_000 ? output.slice(0, 20_000) : output,
          outputTruncated: output.length > 20_000,
        }
      : {}),
  };
  // File edits are shown from afterFileEdit, which carries the actual change.
  return name === 'Edit' || name === 'Write' ? undefined : item;
}

function fileEditItem(input: Rec, now: number, seq: number): ToolItem | undefined {
  const path = str(input.file_path);
  if (!path) return undefined;
  const edits = Array.isArray(input.edits) ? input.edits.filter(isRec) : [];
  const patch = edits
    .map((e) => unifiedDiff(str(e.old_string) ?? '', str(e.new_string) ?? '', path).patch)
    .filter((p) => p !== '')
    .join('\n');
  const { added, removed } = countPatch(patch);
  return {
    kind: 'tool',
    id: `cursor-edit:${str(input.generation_id) ?? now}:${seq}`,
    ts: now,
    name: 'Edit',
    title: path.split('/').pop() ?? path,
    status: 'done',
    detail: { type: 'diff', path, patch, added, removed },
  };
}
