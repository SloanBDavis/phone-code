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
 * submits as the next message of that same chat. A message sent from the phone
 * while Cursor works waits for that hook; when the turn ends and a device has the
 * chat open, the hook waits (up to `holdMs`) for a reply. When nobody follows the
 * chat the hook returns at once, so the desktop is never held up.
 */
import { homedir } from 'node:os';
import type { ChatItem, ToolItem } from '@phone-code/protocol';
import { log } from '../log.ts';
import type { SessionManager } from '../sessions/manager.ts';
import { ChatSession } from '../sessions/chat.ts';
import { cursorInstalled } from '../cursor/hooks.ts';
import { isRec, oneLine, str, type Rec } from './shared/common.ts';
import { countPatch, unifiedDiff } from './shared/diff.ts';
import type { AgentAdapter, AgentEvents, AgentSession, AgentStartOptions } from './types.ts';

export const CURSOR_APP = 'cursor-app';

/** How long a finished turn waits for a reply while someone follows the chat. */
const DEFAULT_HOLD_MS = 10 * 60_000;

interface Conversation {
  events?: AgentEvents;
  /** Replies from the phone not yet handed to Cursor. */
  queued: string[];
  /** A `stop` hook waiting for a reply. */
  waiter?: (reply: string | undefined) => void;
  /** Text handed to Cursor as a follow-up: its beforeSubmitPrompt is not a new user message. */
  delivered?: string;
  turnStartedAt?: number;
  seq: number;
  /** Called when a session attaches (its adapter started). */
  onAttach?: () => void;
}

export class CursorBridge {
  private manager: SessionManager | undefined;
  private readonly conversations = new Map<string, Conversation>();
  readonly holdMs: number;

  constructor(holdMs = Number(process.env['PHONECODE_CURSOR_HOLD_MS']) || DEFAULT_HOLD_MS) {
    this.holdMs = holdMs;
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

  /** A message from the phone: to the waiting `stop` hook, else held for the next one. */
  private reply(id: string, text: string): void {
    const c = this.conv(id);
    if (c.waiter !== undefined) {
      c.waiter(text);
      return;
    }
    c.queued.push(text);
    c.events?.status('idle');
    this.notice(
      id,
      'info',
      'Cursor is not waiting for a reply right now. It gets this message when its current turn in this chat ends.',
      'queued',
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
    switch (event) {
      case 'beforeSubmitPrompt': {
        const prompt = str(input.prompt) ?? '';
        c.turnStartedAt = now;
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
    ev?.upsert({
      kind: 'turn',
      id: `cursor-turn:${str(input.generation_id) ?? ended}`,
      ts: ended,
      outcome: status === 'completed' ? 'completed' : status === 'aborted' ? 'interrupted' : 'error',
      ...(c.turnStartedAt === undefined ? {} : { durationMs: ended - c.turnStartedAt }),
    });
    // Replies sent while Cursor worked go out now.
    if (c.queued.length > 0) return this.followUp(c, c.queued.splice(0).join('\n\n'));
    if (status !== 'completed' || !this.followed(id)) {
      ev?.status('idle');
      return {};
    }
    // Someone has this chat open: wait for their reply (the desktop shows Cursor still finishing).
    ev?.status('waiting');
    const reply = await new Promise<string | undefined>((resolve) => {
      const done = (r: string | undefined): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (c.waiter === done) delete c.waiter;
        resolve(r);
      };
      const aborted = (): void => done(undefined);
      const timer = setTimeout(() => done(undefined), this.holdMs);
      signal?.addEventListener('abort', aborted);
      c.waiter = done;
    });
    if (reply === undefined) {
      ev?.status('idle');
      return {};
    }
    return this.followUp(c, reply);
  }

  private followUp(c: Conversation, text: string): Rec {
    c.delivered = text;
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
