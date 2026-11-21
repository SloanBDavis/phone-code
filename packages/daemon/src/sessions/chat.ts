import { basename } from 'node:path';
import type {
  AgentId,
  Attachment,
  ChatItem,
  CreateSessionParams,
  NoticeItem,
  PermissionDecision,
  PermissionMode,
  ServerMessage,
  SessionInfo,
  SessionStatus,
  UserItem,
} from '@phone-code/protocol';
import { agentDisplayName, type AdapterRegistry, type AgentEvents, type AgentSession } from '../agents/types.ts';
import { log } from '../log.ts';
import { randomId } from '../util/files.ts';
import { EventLog } from './event-log.ts';
import { Fanout } from './fanout.ts';
import { TranscriptFile } from './transcript-file.ts';
import type { LiveSession, PersistedSession, SessionHost, Subscriber } from './types.ts';

const DELTA_COALESCE_MS = 30;
/** Restored sessions start their seq far past anything a client may still hold. */
const RESTORE_SEQ_MARGIN = 100_000;
const MAX_INLINE_ATTACHMENTS = 1_000_000;
/** Item kinds an adapter replays when resuming; dropped if we already own the transcript. */
const HISTORY_KINDS = new Set<ChatItem['kind']>(['user', 'text', 'thinking', 'tool', 'turn']);

export interface ChatDeps {
  host: SessionHost;
  adapters: AdapterRegistry;
  transcriptsDir: string;
}

const AGENT_NAMES: Partial<Record<AgentId, string>> = { claude: 'Claude', codex: 'Codex' };

/** Short name for titles and notices: "Claude", "Codex", else the agent's display name ("Gemini CLI"). */
function shortName(adapters: AdapterRegistry, agent: AgentId): string {
  return AGENT_NAMES[agent] ?? agentDisplayName(adapters, agent);
}

function oneLine(text: string, max = 140): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

function previewOf(item: ChatItem): string | undefined {
  if (item.kind === 'text') return item.text === '' ? undefined : oneLine(item.text);
  if (item.kind === 'user') return `You: ${oneLine(item.text, 120)}`;
  if (item.kind === 'tool') return oneLine(`${item.name}: ${item.title}`);
  if (item.kind === 'notice') return oneLine(item.text);
  if (item.kind === 'permission' && item.status === 'pending')
    return oneLine(`Needs permission: ${item.title}`);
  if (item.kind === 'question' && item.status === 'pending') {
    return oneLine(`Question: ${item.questions[0]?.question ?? ''}`);
  }
  return undefined;
}

export class ChatSession implements LiveSession {
  readonly info: SessionInfo;
  private items: ChatItem[] = [];
  private index = new Map<string, number>();
  private seq: number;
  private readonly log: EventLog;
  private readonly fanout: Fanout;
  private readonly file: TranscriptFile;
  private loaded: Promise<void> | undefined;
  private agent: AgentSession | undefined;
  private starting: Promise<AgentSession | undefined> | undefined;
  private generation = 0;
  private nativeSessionId: string | undefined;
  private titleLocked: boolean;
  private autoTitle: boolean;
  private suppressHistory = false;
  private pendingDelta: { itemId: string; text: string } | undefined;
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private constructor(
    private readonly deps: ChatDeps,
    info: SessionInfo,
    seq: number,
    titleLocked: boolean,
    nativeSessionId: string | undefined,
  ) {
    this.info = info;
    this.seq = seq;
    this.log = new EventLog(seq);
    this.fanout = new Fanout(info.id);
    this.file = new TranscriptFile(deps.transcriptsDir, info.id);
    this.titleLocked = titleLocked;
    this.autoTitle = !titleLocked;
    this.nativeSessionId = nativeSessionId;
  }

  static create(
    id: string,
    agent: AgentId,
    cwd: string,
    params: CreateSessionParams,
    deps: ChatDeps,
  ): ChatSession {
    const now = Date.now();
    const title = params.title?.trim();
    const info: SessionInfo = {
      id,
      kind: 'agent',
      agent,
      agentName: agentDisplayName(deps.adapters, agent),
      title: title !== undefined && title !== '' ? title : `${shortName(deps.adapters, agent)} · ${basename(cwd) || cwd}`,
      cwd,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      ...(params.model === undefined ? {} : { model: params.model }),
      permissionMode: params.permissionMode ?? 'default',
    };
    const s = new ChatSession(deps, info, 0, title !== undefined && title !== '', params.resumeId);
    // A resumed session's history comes from the adapter, so don't auto-title from our first message.
    if (params.resumeId !== undefined) s.autoTitle = false;
    s.loaded = Promise.resolve();
    void s.ensureAgent();
    return s;
  }

  static restore(rec: PersistedSession, deps: ChatDeps): ChatSession {
    const status: SessionStatus =
      rec.info.status === 'running' || rec.info.status === 'waiting' ? 'idle' : rec.info.status;
    const info: SessionInfo = { ...rec.info, status };
    if (info.agent !== undefined && info.agentName === undefined)
      info.agentName = agentDisplayName(deps.adapters, info.agent);
    const s = new ChatSession(deps, info, rec.seq + RESTORE_SEQ_MARGIN, rec.titleLocked, rec.nativeSessionId);
    s.autoTitle = false;
    return s;
  }

  // ------------------------------------------------------------ lifecycle

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.file.load().then(
      (items) => {
        // Events that raced the load (none expected) stay after the restored items.
        const live = this.items;
        this.items = [];
        this.index.clear();
        for (const item of [...items, ...live]) this.place(item);
        return undefined;
      },
      (err: unknown) => log.error(`could not load transcript ${this.info.id}`, err),
    );
    return this.loaded;
  }

  private ensureAgent(): Promise<AgentSession | undefined> {
    if (this.agent !== undefined) return Promise.resolve(this.agent);
    if (this.disposed) return Promise.resolve(undefined);
    this.starting ??= this.startAgent().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startAgent(): Promise<AgentSession | undefined> {
    await this.ensureLoaded();
    const kind = this.info.agent ?? 'claude';
    const adapter = this.deps.adapters[kind];
    if (adapter === undefined) {
      this.notice(
        'error',
        `${this.info.agentName ?? kind} is not set up on this computer any more (no agent "${kind}" in phone-code's agent list).`,
      );
      this.setStatus('error');
      return undefined;
    }
    this.generation += 1;
    const events = this.eventsFor(this.generation);
    this.suppressHistory = this.items.length > 0 && this.nativeSessionId !== undefined;
    try {
      const agent = await adapter.start(
        {
          cwd: this.info.cwd,
          ...(this.info.model === undefined ? {} : { model: this.info.model }),
          ...(this.info.permissionMode === undefined ? {} : { permissionMode: this.info.permissionMode }),
          ...(this.nativeSessionId === undefined ? {} : { resumeId: this.nativeSessionId }),
        },
        events,
      );
      if (this.disposed) {
        await agent.dispose();
        return undefined;
      }
      this.agent = agent;
      return agent;
    } catch (err) {
      log.warn(`agent ${kind} failed to start for session ${this.info.id}`, err);
      this.notice(
        'error',
        `Could not start ${shortName(this.deps.adapters, kind)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.setStatus('error');
      return undefined;
    } finally {
      this.suppressHistory = false;
    }
  }

  private eventsFor(gen: number): AgentEvents {
    const live = (): boolean => gen === this.generation && !this.disposed;
    return {
      upsert: (item) => {
        if (!live()) return;
        if (this.suppressHistory && !this.index.has(item.id) && HISTORY_KINDS.has(item.kind)) return;
        this.upsert(item);
      },
      delta: (itemId, text) => {
        if (live()) this.delta(itemId, text);
      },
      status: (status) => {
        if (live()) this.setStatus(status);
      },
      nativeSessionId: (id) => {
        if (!live() || id === this.nativeSessionId) return;
        this.nativeSessionId = id;
        this.deps.host.changed('structure');
      },
      meta: (meta) => {
        if (!live()) return;
        if (meta.model !== undefined) this.info.model = meta.model;
        if (meta.permissionMode !== undefined) this.info.permissionMode = meta.permissionMode;
        if (meta.permissionModes !== undefined) this.info.permissionModes = meta.permissionModes;
        if (meta.models !== undefined) this.info.models = meta.models;
        if (meta.title !== undefined && meta.title.trim() !== '' && !this.titleLocked) {
          this.info.title = oneLine(meta.title, 100);
          this.autoTitle = false;
        }
        this.deps.host.changed('structure');
      },
    };
  }

  // ---------------------------------------------------- transcript mutation

  private place(item: ChatItem): void {
    const at = this.index.get(item.id);
    if (at === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[at] = item;
    }
  }

  private emit(msg: ServerMessage): void {
    const frame = JSON.stringify(msg);
    this.log.push(this.seq, frame);
    this.fanout.publish(frame);
  }

  private upsert(input: ChatItem): void {
    this.flushDelta();
    const item: ChatItem = { ...input };
    this.place(item);
    this.seq += 1;
    this.emit({ t: 'chat.item', sessionId: this.info.id, seq: this.seq, item });
    this.file.touch(item);
    this.activity(previewOf(item));
    if (item.kind === 'turn' && this.fanout.size === 0) this.deps.host.attention(this.info, 'turn');
  }

  private delta(itemId: string, text: string): void {
    if (text === '') return;
    if (this.pendingDelta !== undefined && this.pendingDelta.itemId !== itemId) this.flushDelta();
    if (this.pendingDelta === undefined) this.pendingDelta = { itemId, text };
    else this.pendingDelta.text += text;
    this.deltaTimer ??= setTimeout(() => this.flushDelta(), DELTA_COALESCE_MS);
  }

  private flushDelta(): void {
    if (this.deltaTimer !== undefined) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
    const pending = this.pendingDelta;
    if (pending === undefined) return;
    this.pendingDelta = undefined;
    const at = this.index.get(pending.itemId);
    const item = at === undefined ? undefined : this.items[at];
    if (item === undefined || (item.kind !== 'text' && item.kind !== 'thinking')) {
      log.debug(`dropping delta for unknown item in ${this.info.id}`);
      return;
    }
    item.text += pending.text;
    this.seq += 1;
    this.emit({
      t: 'chat.delta',
      sessionId: this.info.id,
      seq: this.seq,
      itemId: item.id,
      text: pending.text,
    });
    this.file.touch(item);
    if (item.kind === 'text') this.activity(previewOf(item));
  }

  private activity(preview: string | undefined): void {
    this.info.updatedAt = Date.now();
    if (preview !== undefined) this.info.preview = preview;
    if (this.fanout.size === 0 && this.info.unread !== true) {
      this.info.unread = true;
      this.deps.host.changed('structure');
    } else {
      this.deps.host.changed('activity');
    }
  }

  private setStatus(status: SessionStatus): void {
    if (this.info.status === status) return;
    this.flushDelta();
    this.info.status = status;
    this.deps.host.changed('structure');
    if (status === 'waiting' && this.fanout.size === 0) this.deps.host.attention(this.info, 'waiting');
  }

  private notice(level: NoticeItem['level'], text: string): void {
    this.upsert({ id: `n_${randomId()}`, ts: Date.now(), kind: 'notice', level, text });
  }

  // ------------------------------------------------------------ client API

  async subscribe(sub: Subscriber, afterSeq?: number): Promise<void> {
    await this.ensureLoaded();
    this.flushDelta();
    const missed = afterSeq === undefined ? undefined : this.log.since(afterSeq, this.seq);
    if (missed === undefined) {
      const snapshot: ServerMessage = {
        t: 'chat.snapshot',
        sessionId: this.info.id,
        seq: this.seq,
        items: this.items,
      };
      if (!this.fanout.sendTo(sub, JSON.stringify(snapshot))) return;
    } else {
      for (const frame of missed) if (!this.fanout.sendTo(sub, frame)) return;
    }
    this.fanout.add(sub);
    if (this.info.unread === true) {
      this.info.unread = false;
      this.deps.host.changed('structure');
    }
  }

  unsubscribe(sub: Subscriber): void {
    this.fanout.delete(sub);
  }

  hasSubscribers(): boolean {
    return this.fanout.size > 0;
  }

  rename(title: string): void {
    this.info.title = title;
    this.titleLocked = true;
    this.autoTitle = false;
    this.deps.host.changed('structure');
  }

  /** Adds the UserItem and hands the message to the agent. Returns the item id. */
  async send(text: string, attachments: Attachment[] | undefined): Promise<string> {
    await this.ensureLoaded();
    const item: UserItem = { id: `u_${randomId()}`, ts: Date.now(), kind: 'user', text };
    if (attachments !== undefined && attachments.length > 0) {
      const total = attachments.reduce((n, a) => n + a.data.length, 0);
      item.attachments = attachments.map((a) => ({
        mediaType: a.mediaType,
        ...(a.name === undefined ? {} : { name: a.name }),
        ...(total <= MAX_INLINE_ATTACHMENTS ? { data: a.data } : {}),
      }));
    }
    this.upsert(item);
    if (this.autoTitle && text.trim() !== '') {
      this.info.title = oneLine(text, 60).replace(/^…/, '');
      this.autoTitle = false;
      this.deps.host.changed('structure');
    }
    void this.deliver(text, attachments);
    return item.id;
  }

  private async deliver(text: string, attachments: Attachment[] | undefined): Promise<void> {
    const agent = await this.ensureAgent();
    if (agent === undefined) return;
    this.setStatus('running');
    try {
      await agent.send(text, attachments);
    } catch (err) {
      this.notice('error', `Failed to send: ${err instanceof Error ? err.message : String(err)}`);
      this.setStatus('error');
    }
  }

  interrupt(): void {
    this.agent?.interrupt().catch((err: unknown) => log.warn(`interrupt failed in ${this.info.id}`, err));
  }

  resolvePermission(itemId: string, decision: PermissionDecision, message?: string): void {
    this.agent?.resolvePermission(itemId, decision, message);
  }

  answerQuestion(itemId: string, answers: Record<string, string>): void {
    this.agent?.answerQuestion(itemId, answers);
  }

  setMode(mode: PermissionMode): void {
    this.info.permissionMode = mode;
    this.deps.host.changed('structure');
    this.agent?.setPermissionMode(mode).catch((err: unknown) => log.warn('setPermissionMode failed', err));
  }

  setModel(model: string): void {
    this.info.model = model;
    this.deps.host.changed('structure');
    this.agent?.setModel(model).catch((err: unknown) => log.warn('setModel failed', err));
  }

  toRecord(): PersistedSession {
    return {
      info: this.info,
      seq: this.seq,
      titleLocked: this.titleLocked,
      ...(this.nativeSessionId === undefined ? {} : { nativeSessionId: this.nativeSessionId }),
    };
  }

  async persist(): Promise<void> {
    this.flushDelta();
    await this.file.flush();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.fanout.clear();
    this.flushDelta();
    const agent = this.agent ?? (await this.starting);
    this.agent = undefined;
    if (agent !== undefined) {
      await agent
        .dispose()
        .catch((err: unknown) => log.warn(`agent dispose failed for ${this.info.id}`, err));
    }
    await this.file.flush();
  }

  removeFiles(): Promise<void> {
    return this.file.remove();
  }
}
