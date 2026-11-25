import { basename } from 'node:path';
import type {
  AgentId,
  Attachment,
  ChatItem,
  CreateSessionParams,
  ImageRef,
  NoticeItem,
  PermissionDecision,
  PermissionMode,
  ServerMessage,
  SessionInfo,
  SessionStatus,
  SlashCommand,
  UserItem,
} from '@phone-code/protocol';
import {
  agentDisplayName,
  type AdapterRegistry,
  type AgentAttachment,
  type AgentEvents,
  type AgentSession,
} from '../agents/types.ts';
import { artifactRoots, imagePathsIn } from '../images/markdown.ts';
import { sniffImage } from '../images/sniff.ts';
import type { ImageStore } from '../images/store.ts';
import { log } from '../log.ts';
import { UserError } from '../util/errors.ts';
import { randomId } from '../util/files.ts';
import { EventLog } from './event-log.ts';
import { Fanout } from './fanout.ts';
import { TranscriptFile } from './transcript-file.ts';
import type { LiveSession, PersistedSession, SessionHost, Subscriber } from './types.ts';

const DELTA_COALESCE_MS = 30;
/** Restored sessions start their seq far past anything a client may still hold. */
const RESTORE_SEQ_MARGIN = 100_000;
/** Item kinds an adapter replays when resuming; dropped if we already own the transcript. */
const HISTORY_KINDS = new Set<ChatItem['kind']>(['user', 'text', 'thinking', 'tool', 'turn']);

export interface ChatDeps {
  host: SessionHost;
  adapters: AdapterRegistry;
  transcriptsDir: string;
  images: ImageStore;
}

/**
 * Bytes the image store accepts, converting what it does not (an iPhone's
 * HEIC on macOS, BMP, TIFF) to JPEG with Bun.Image when this computer can
 * decode it. Undefined when it is not an image we can show.
 */
async function normalizeImage(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (sniffImage(bytes) !== undefined) return bytes;
  try {
    const out = await new Bun.Image(bytes, { maxPixels: 64_000_000 }).jpeg({ quality: 88 }).bytes();
    return sniffImage(out) === undefined ? undefined : out;
  } catch {
    return undefined;
  }
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
  // What a sub-agent says or does is inside its card: the chat's preview stays the main thread's.
  if (
    (item.kind === 'text' || item.kind === 'thinking' || item.kind === 'tool') &&
    item.parentId !== undefined
  )
    return undefined;
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
  private commands: SlashCommand[] | undefined;
  /** Text items already scanned for local image references (id + text length). */
  private readonly scanned = new Set<string>();

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
      title:
        title !== undefined && title !== ''
          ? title
          : `${shortName(deps.adapters, agent)} · ${basename(cwd) || cwd}`,
      cwd,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.effort === undefined ? {} : { effort: params.effort }),
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
          ...(this.info.effort === undefined ? {} : { effort: this.info.effort }),
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
        if (meta.modelOptions !== undefined) this.info.modelOptions = meta.modelOptions;
        if (meta.effort !== undefined) this.info.effort = meta.effort;
        if (meta.efforts !== undefined) {
          if (meta.efforts.length) this.info.efforts = meta.efforts;
          else delete this.info.efforts;
        }
        if (meta.commands !== undefined) {
          this.commands = meta.commands;
          if (Object.keys(meta).length === 1) return; // commands are not part of SessionInfo
        }
        if (meta.title !== undefined && meta.title.trim() !== '' && !this.titleLocked) {
          this.info.title = oneLine(meta.title, 100);
          this.autoTitle = false;
        }
        this.deps.host.changed('structure');
      },
      image: (data, name) => {
        const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
        const res = this.deps.images.put(this.info.id, bytes, name);
        if (!res.ok) log.debug(`agent image not stored in ${this.info.id}: ${res.error}`);
        return res.ok ? res.ref : undefined;
      },
      imageFile: (path, name) => this.deps.images.putFile(this.info.id, path, this.imageRoots(), name),
    };
  }

  /** Where local image files may be read from for this session (see images/markdown.ts). */
  private imageRoots(): string[] {
    return [this.info.cwd, ...artifactRoots(this.info.agent ?? 'claude')];
  }

  /** Attach the local images a finished text item links to (once per id and text). */
  private scanImages(item: ChatItem): void {
    if (item.kind !== 'text' || item.streaming || item.text === '') return;
    const key = `${item.id}:${item.text.length}`;
    if (this.scanned.has(key)) return;
    this.scanned.add(key);
    const paths = imagePathsIn(item.text, this.info.cwd);
    if (paths.length === 0) return;
    void Promise.all(
      paths.map((p) => this.deps.images.putFile(this.info.id, p, this.imageRoots(), basename(p))),
    ).then((found) => {
      const refs = found.filter((r): r is ImageRef => r !== undefined);
      const at = this.index.get(item.id);
      const cur = at === undefined ? undefined : this.items[at];
      if (refs.length === 0 || this.disposed || cur?.kind !== 'text' || cur.text !== item.text)
        return undefined;
      const have = new Set((cur.images ?? []).map((r) => r.id));
      const add = refs.filter((r) => !have.has(r.id));
      if (add.length > 0) this.upsert({ ...cur, images: [...(cur.images ?? []), ...add] });
      return undefined;
    });
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
    // Adapters re-send items without the image refs the core attached: keep them.
    const at = this.index.get(item.id);
    const prev = at === undefined ? undefined : this.items[at];
    if (
      prev !== undefined &&
      (item.kind === 'text' || item.kind === 'tool') &&
      prev.kind === item.kind &&
      item.images === undefined &&
      prev.images !== undefined &&
      (item.kind !== 'text' || (prev.kind === 'text' && prev.text === item.text))
    ) {
      item.images = prev.images;
    }
    this.place(item);
    this.seq += 1;
    this.emit({ t: 'chat.item', sessionId: this.info.id, seq: this.seq, item });
    this.file.touch(item);
    this.activity(previewOf(item));
    if (item.kind === 'turn' && this.fanout.size === 0) this.deps.host.attention(this.info, 'turn');
    this.scanImages(item);
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

  /**
   * Images go to the session's image store (type sniffed from the bytes) and
   * reach the agent with their stored path; other files pass through as before.
   */
  private async storeAttachments(
    attachments: Attachment[],
  ): Promise<{ forAgent: AgentAttachment[]; images: ImageRef[]; others: Attachment[] }> {
    const forAgent: AgentAttachment[] = [];
    const images: ImageRef[] = [];
    const others: Attachment[] = [];
    for (const a of attachments) {
      const raw = Buffer.from(a.data, 'base64');
      const looksImage = a.mediaType.startsWith('image/') || sniffImage(raw) !== undefined;
      if (!looksImage) {
        forAgent.push(a);
        others.push(a);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- at most 10, in order
      const bytes = await normalizeImage(raw);
      if (bytes === undefined)
        throw new UserError(`${a.name ?? 'That file'} is not a PNG, JPEG, GIF or WebP image.`);
      const res = this.deps.images.put(this.info.id, bytes, a.name);
      if (!res.ok) throw new UserError(`Could not attach ${a.name ?? 'the image'}: ${res.error}`);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const path = await this.deps.images.pathOf(this.info.id, res.ref.id);
      images.push(res.ref);
      forAgent.push({
        mediaType: res.ref.mediaType,
        data: bytes === raw ? a.data : Buffer.from(bytes).toString('base64'),
        ...(a.name === undefined ? {} : { name: a.name }),
        ...(path === undefined ? {} : { path }),
        ref: res.ref,
      });
    }
    return { forAgent, images, others };
  }

  /** Adds the UserItem and hands the message to the agent. Returns the item id. */
  async send(text: string, attachments: Attachment[] | undefined): Promise<string> {
    await this.ensureLoaded();
    const item: UserItem = { id: `u_${randomId()}`, ts: Date.now(), kind: 'user', text };
    let forAgent: AgentAttachment[] | undefined;
    if (attachments !== undefined && attachments.length > 0) {
      const stored = await this.storeAttachments(attachments);
      forAgent = stored.forAgent;
      if (stored.images.length > 0) item.images = stored.images;
      // Transcripts carry no inline bytes any more: only what the other files were.
      if (stored.others.length > 0)
        item.attachments = stored.others.map((a) =>
          a.name === undefined ? { mediaType: a.mediaType } : { mediaType: a.mediaType, name: a.name },
        );
    }
    if (this.info.archived === true) {
      // Sending to an archived chat brings it back to the sidebar.
      delete this.info.archived;
      this.deps.host.changed('structure');
    }
    this.upsert(item);
    if (this.autoTitle && text.trim() !== '') {
      this.info.title = oneLine(text, 60).replace(/^…/, '');
      this.autoTitle = false;
      this.deps.host.changed('structure');
    }
    void this.deliver(text, forAgent);
    return item.id;
  }

  private async deliver(text: string, attachments: AgentAttachment[] | undefined): Promise<void> {
    const agent = await this.ensureAgent();
    if (agent === undefined) return;
    // A pending permission / question keeps the session `waiting`: the adapter only
    // reports status changes, so it would not correct an overwrite here.
    if (this.info.status !== 'waiting') this.setStatus('running');
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

  setEffort(effort: string): void {
    this.info.effort = effort;
    this.deps.host.changed('structure');
    this.agent?.setEffort?.(effort).catch((err: unknown) => log.warn('setEffort failed', err));
  }

  /** The agent's own conversation id, once known (what history entries call resumeId). */
  get nativeId(): string | undefined {
    return this.nativeSessionId;
  }

  /** Slash commands the running agent reported, if it did. */
  get agentCommands(): SlashCommand[] | undefined {
    return this.commands;
  }

  /**
   * Archive (hide from the sidebar, stop the agent process, keep the
   * transcript) or bring back. The agent starts again, resuming the same
   * conversation, with the next message.
   */
  async setArchived(archived: boolean): Promise<void> {
    if (archived) {
      this.info.archived = true;
      this.info.unread = false;
      this.deps.host.changed('structure');
      await this.suspend();
    } else if (this.info.archived === true) {
      delete this.info.archived;
      this.deps.host.changed('structure');
    }
  }

  /** Stop the agent process but keep the session usable (it restarts lazily on the next message). */
  private async suspend(): Promise<void> {
    this.flushDelta();
    const agent = this.agent ?? (await this.starting);
    this.agent = undefined;
    if (agent !== undefined) {
      await agent
        .dispose()
        .catch((err: unknown) => log.warn(`agent dispose failed for ${this.info.id}`, err));
    }
    // Late events of the stopped process are ignored from here on.
    this.generation += 1;
    this.commands = undefined;
    if (!this.disposed) this.setStatus('idle');
    await this.file.flush();
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

  async removeFiles(): Promise<void> {
    await Promise.all([this.file.remove(), this.deps.images.removeSession(this.info.id)]);
  }
}
