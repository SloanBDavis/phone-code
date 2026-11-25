/**
 * OpenAI Codex adapter.
 *
 * Route: `codex app-server` (JSON-RPC 2.0 over stdio, one JSON object per line,
 * without the "jsonrpc" field). Chosen over `codex exec --json` because only
 * app-server has approvals, interrupt and resume. Message shapes come from
 * `codex app-server generate-ts` of codex-cli 0.171.0 (stable API only, no
 * `experimentalApi`), and the framing was checked against the real binary
 * (initialize, thread/start, turn/start, error/turn/completed notifications,
 * thread/resume, thread/turns/list); model turns themselves could not be run
 * here (no OpenAI credentials).
 *
 * Flow: initialize -> initialized -> thread/start | thread/resume (+ thread/turns/list
 * for history) -> turn/start per message, turn/interrupt to stop. The server
 * sends approvals as requests (item/commandExecution/requestApproval,
 * item/fileChange/requestApproval, item/tool/requestUserInput, ...).
 *
 * PermissionMode -> Codex approval policy + sandbox:
 *   default            approvalPolicy "untrusted"  + sandbox workspace-write
 *                      (ask before anything that is not a known-safe read, like Claude's default)
 *   acceptEdits        approvalPolicy "on-request" + sandbox workspace-write
 *                      (edits and commands inside the workspace sandbox run; the model asks to escalate)
 *   plan               approvalPolicy "untrusted"  + sandbox read-only
 *                      (Codex's own plan collaboration mode is experimental API; read-only is the stable equivalent)
 *   bypassPermissions  approvalPolicy "never"      + sandbox danger-full-access
 */
import { randomUUID } from 'node:crypto';
import type {
  ModelOption,
  ChatItem,
  NoticeItem,
  PermissionDecision,
  PermissionItem,
  PermissionMode,
  QuestionItem,
  ImageRef,
  ResumableSession,
  SlashCommand,
  ToolItem,
  TurnItem,
  ToolStatus,
} from '@phone-code/protocol';
import type { AgentAdapter, AgentAttachment, AgentEvents, AgentSession, AgentStartOptions } from './types.ts';
import { fileChangeDetail, mapThreadItem, unwrapShell } from './codex-map.ts';
import { listCodexResumable } from './codex-history.ts';
import {
  StatusTracker,
  arr,
  effortOptions,
  errorMessage,
  isRec,
  num,
  oneLine,
  rec,
  safeEvents,
  str,
  toQuestion,
  truncateOutput,
  type Rec,
} from './shared/common.ts';
import { childEnv, runQuick, spawnAgent, type SpawnedAgent } from './shared/proc.ts';

const CLIENT_VERSION = '0.1.0';
const DEFAULT_MODELS: ModelOption[] = [{ id: 'gpt-5-codex' }, { id: 'gpt-5' }];

/**
 * The app-server has no slash commands of its own (they are a TUI feature),
 * so phone-code maps these onto its stable methods. Skills reported by
 * `skills/list` are added per session and sent the way the TUI's composer
 * does, as a `$skill` mention in the text.
 */
const CODEX_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', source: 'builtin' },
  {
    name: 'review',
    description: 'Review the uncommitted changes in this folder',
    argumentHint: '[instructions]',
    source: 'builtin',
  },
];

/** `/name rest` -> [name, rest] */
function slashCommand(text: string): [string, string] | undefined {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m?.[1] === undefined ? undefined : [m[1], m[2]?.trim() ?? ''];
}

/** Base64 bytes of a `data:image/...;base64,` URL. */
function dataUrlBytes(url: string | undefined): string | undefined {
  const m = url === undefined ? null : /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(url);
  return m?.[1];
}

export function codexBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PHONECODE_CODEX_BIN || 'codex';
}

let discoveredModels: ModelOption[] | undefined;

/** `model/list` result data: [{id, displayName, description, hidden, isDefault, ...}]. */
function parseModels(data: unknown): ModelOption[] {
  const out: ModelOption[] = [];
  for (const m of arr(data).map(rec)) {
    const id = str(m.id) ?? str(m.model);
    if (!id || m.hidden === true || out.some((o) => o.id === id)) continue;
    const name = str(m.displayName);
    const description = str(m.description);
    // `supportedReasoningEfforts: [{reasoningEffort: "low", description}]`, `defaultReasoningEffort: "medium"`.
    const efforts = effortOptions(
      arr(m.supportedReasoningEfforts)
        .map(rec)
        .flatMap((e) => {
          const eid = str(e.reasoningEffort);
          const d = str(e.description);
          return eid ? [{ id: eid, ...(d ? { description: d } : {}) }] : [];
        }),
    );
    const defaultEffort = str(m.defaultReasoningEffort);
    out.push({
      id,
      ...(name && name !== id ? { name } : {}),
      ...(description ? { description } : {}),
      ...(m.isDefault === true ? { isDefault: true } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(efforts.length && defaultEffort ? { defaultEffort } : {}),
    });
  }
  return out;
}

type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

const POLICY: Record<PermissionMode, { approvalPolicy: ApprovalPolicy; sandbox: SandboxMode }> = {
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  // Not offered for Codex (Claude Code's classifier mode); if asked for, Codex's own "Auto" preset.
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

function policyFor(mode: PermissionMode): { approvalPolicy: ApprovalPolicy; sandbox: SandboxMode } {
  return POLICY[mode];
}

/** turn/start takes a SandboxPolicy object rather than the SandboxMode string. */
const SANDBOX_POLICY: Record<SandboxMode, Rec> = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'danger-full-access': { type: 'dangerFullAccess' },
  'workspace-write': {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
};

interface PendingRequest {
  rpcId: string | number;
  method: string;
  item: PermissionItem | QuestionItem;
  /** question text -> question id (requestUserInput) */
  questionIds?: Map<string, string>;
}

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class CodexSession implements AgentSession {
  private proc: SpawnedAgent | undefined;
  private readonly events: AgentEvents;
  private readonly status: StatusTracker;
  private readonly waiters = new Map<number, Waiter>();
  private nextId = 1;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private model: string | undefined;
  /** Thinking level chosen on phone-code (sent with the next turn/start). */
  private effort: string | undefined;
  private mode: PermissionMode;
  private readonly items = new Map<string, ChatItem>();
  /** Sub-agent thread id -> the Task card of the call that started it. */
  private readonly subThreads = new Map<string, string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly byRpc = new Map<string, string>();
  /** Cumulative thread token totals at the start of the current turn. */
  /** null until the first usage report after (re)start: a resumed thread's totals include old turns. */
  private tokensAtTurnStart: { input: number; output: number } | null = null;
  private tokensNow = { input: 0, output: 0 };
  private turnStartedAt = 0;
  private interruptRequested = false;
  private disposed = false;
  private ready: Promise<void> | undefined;
  private noticeSeq = 0;
  private overridesDirty = false;
  private readonly fileChanges = new Map<string, unknown>();
  private skills: SlashCommand[] = [];

  constructor(
    private readonly opts: AgentStartOptions,
    events: AgentEvents,
  ) {
    this.events = safeEvents(events);
    this.status = new StatusTracker(this.events);
    this.model = opts.model;
    this.effort = opts.effort;
    this.mode = opts.permissionMode ?? 'default';
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    this.ready = this.boot(this.opts.resumeId, true);
    try {
      await this.ready;
    } catch {
      // reported through notice + status already
    }
    this.status.emit();
  }

  private async boot(resumeId: string | undefined, loadHistory: boolean): Promise<void> {
    const bin = codexBin(this.opts.env ?? process.env);
    const proc = spawnAgent(bin, ['app-server'], {
      cwd: this.opts.cwd,
      env: childEnv(this.opts.env, ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']),
      onLine: (v) => this.onLine(v),
      onInputLost: () => this.onInputLost(proc),
    });
    this.proc = proc;
    this.status.crashed = false;
    // Token totals are per app-server process.
    this.tokensNow = { input: 0, output: 0 };
    this.tokensAtTurnStart = null;
    void proc.exited.then((info) => this.onExit(proc, info));
    try {
      await this.call('initialize', {
        clientInfo: { name: 'phone_code', title: 'phone-code', version: CLIENT_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.notify('initialized');
      const { approvalPolicy, sandbox } = policyFor(this.mode);
      const common = {
        cwd: this.opts.cwd,
        approvalPolicy,
        sandbox,
        ...(this.model ? { model: this.model } : {}),
      };
      const res = rec(
        resumeId
          ? await this.call('thread/resume', { threadId: resumeId, ...common, excludeTurns: true })
          : await this.call('thread/start', common),
      );
      const thread = rec(res.thread);
      this.threadId = str(thread.id);
      if (this.threadId) this.events.nativeSessionId(this.threadId);
      const model = str(res.model);
      if (model) this.model = model;
      const name = str(thread.name);
      // The thread's level until one is chosen here (thread/start takes none; turn/start does).
      const effort = this.effort ?? str(res.reasoningEffort);
      this.events.meta({
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        permissionMode: this.mode,
        ...(name ? { title: name } : {}),
      });
      if (resumeId && loadHistory && this.threadId) await this.loadHistory(this.threadId);
      // A chosen level goes out with the first turn.
      this.overridesDirty = this.effort !== undefined;
      void this.discoverModels();
      void this.discoverSkills();
    } catch (e) {
      if (this.proc === proc && !this.disposed) {
        this.notice('error', `Could not start Codex: ${errorMessage(e)}`);
        this.status.crashed = true;
        this.status.emit();
      }
      throw e;
    }
  }

  private async discoverModels(): Promise<void> {
    try {
      const r = await this.call('model/list', {});
      const options = parseModels(rec(r).data);
      if (options.length) {
        discoveredModels = options;
        this.events.meta({ models: options.map((o) => o.id), modelOptions: options });
      }
    } catch {
      // optional
    }
  }

  /** `skills/list` for this folder (recent codex-cli; an older one just has none). */
  private async discoverSkills(): Promise<void> {
    try {
      const r = rec(await this.call('skills/list', { cwds: [this.opts.cwd] }, 10_000));
      const skills: SlashCommand[] = [];
      for (const entry of arr(r.data).map(rec)) {
        for (const sk of arr(entry.skills).map(rec)) {
          const name = str(sk.name);
          if (!name || skills.some((x) => x.name === name)) continue;
          const description = str(sk.shortDescription) ?? str(sk.description);
          const scope = str(sk.scope);
          skills.push({
            name,
            ...(description ? { description } : {}),
            source: scope === 'repo' ? 'project' : scope === 'system' ? 'builtin' : 'user',
          });
        }
      }
      this.skills = skills;
    } catch {
      this.skills = [];
    }
    this.events.meta({ commands: [...CODEX_COMMANDS, ...this.skills] });
  }

  /** Images in a thread item: MCP / dynamic tool image results, and the file an `imageView` looked at. */
  private attachImages(raw: Rec, mapped: ChatItem): void {
    if (mapped.kind !== 'tool') return;
    const refs: ImageRef[] = [];
    const add = (ref: ImageRef | undefined): void => {
      if (ref && !refs.some((r) => r.id === ref.id) && !mapped.images?.some((r) => r.id === ref.id))
        refs.push(ref);
    };
    for (const c of arr(rec(raw.result).content).map(rec)) {
      const data = str(c.data);
      if (c.type === 'image' && data) add(this.events.image(data));
    }
    for (const c of arr(raw.contentItems).map(rec)) {
      const data = dataUrlBytes(str(c.imageUrl) ?? str(c.image_url));
      if (data) add(this.events.image(data));
    }
    if (refs.length) mapped.images = [...(mapped.images ?? []), ...refs];
    const p = raw.type === 'imageView' ? str(raw.path) : undefined;
    if (p) {
      void this.events.imageFile(p).then((ref) => {
        const cur = this.items.get(mapped.id);
        if (!ref || cur?.kind !== 'tool' || cur.images?.some((r) => r.id === ref.id)) return undefined;
        this.upsertItem({ ...cur, images: [...(cur.images ?? []), ref] });
        return undefined;
      });
    }
  }

  private async loadHistory(threadId: string): Promise<void> {
    try {
      const res = rec(
        await this.call('thread/turns/list', {
          threadId,
          itemsView: 'full',
          sortDirection: 'desc',
          limit: 50,
        }),
      );
      const turns = arr(res.data).map(rec).toReversed();
      for (const turn of turns) {
        const started = (num(turn.startedAt) ?? 0) * 1000;
        for (const it of arr(turn.items)) {
          const ts = num(rec(it).startedAtMs) ?? (started || Date.now());
          const mapped = mapThreadItem(it, this.opts.cwd, { ts, history: true });
          if (mapped) {
            this.attachImages(rec(it), mapped);
            if (mapped.kind === 'tool' && mapped.status === 'running') mapped.status = 'error';
            this.items.set(mapped.id, mapped);
            this.events.upsert(mapped);
          }
        }
        const status = str(turn.status);
        if (status && status !== 'inProgress') {
          const err = str(rec(turn.error).message);
          this.events.upsert({
            kind: 'turn',
            id: `turn:${str(turn.id) ?? randomUUID()}`,
            ts: (num(turn.completedAt) ?? 0) * 1000 || Date.now(),
            outcome:
              status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'error',
            ...(num(turn.durationMs) !== undefined ? { durationMs: num(turn.durationMs) } : {}),
            ...(err ? { error: err } : {}),
          });
        }
      }
    } catch (e) {
      this.notice('warn', `Could not load the past conversation: ${errorMessage(e)}`);
    }
  }

  private onExit(
    proc: SpawnedAgent,
    info: { code: number | null; signal: NodeJS.Signals | null; error?: Error },
  ): void {
    let text: string;
    if (info.error && /ENOENT/.test(info.error.message)) {
      text = `Codex CLI not found (${codexBin(this.opts.env ?? process.env)}). Install it with \`npm i -g @openai/codex\` or set PHONECODE_CODEX_BIN.`;
    } else {
      const tail = oneLine(proc.stderrTail().trim().split('\n').slice(-3).join(' '), 300);
      text = `Codex exited unexpectedly (${info.signal ?? `code ${info.code ?? '?'}`})${tail ? `: ${tail}` : ''}`;
    }
    this.lost(proc, text);
  }

  /** The app-server runs but takes no more input: drop it like a crash, so the next message starts a new one. */
  private onInputLost(proc: SpawnedAgent): void {
    if (this.proc !== proc || this.disposed) return;
    this.lost(
      proc,
      'Codex stopped reading its input, so phone-code stopped it. Send your message again to restart it.',
    );
    void proc.kill();
  }

  /** The process is gone (or unusable): end the turn as an error and wait for the next message. */
  private lost(proc: SpawnedAgent, text: string): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    for (const w of this.waiters.values()) w.reject(new Error('Codex exited'));
    this.waiters.clear();
    this.cancelAllPending();
    if (this.disposed) return;
    const wasActive = this.status.turnActive;
    this.finishOpenItems('error');
    this.status.turnActive = false;
    this.turnId = undefined;
    this.notice('error', text);
    if (wasActive) {
      this.events.upsert({
        kind: 'turn',
        id: `turn:${randomUUID()}`,
        ts: Date.now(),
        outcome: 'error',
        // The notice above already carries the details.
      });
    }
    this.status.crashed = true;
    this.status.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllPending();
    this.finishOpenItems('interrupted');
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await proc.kill();
    this.status.turnActive = false;
    this.status.crashed = false;
    this.status.exited = true;
    this.status.emit();
  }

  // --------------------------------------------------------------- rpc

  private call(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error('Codex is not running'));
        return;
      }
      // A failed write is reported through onInputLost / onExit, which reject every waiter.
      this.proc.writeJson({ id, method, params });
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.proc?.writeJson(params === undefined ? { method } : { method, params });
  }

  private reply(id: string | number, result: unknown): void {
    this.proc?.writeJson({ id, result });
  }

  private replyError(id: string | number, message: string, code = -32601): void {
    this.proc?.writeJson({ id, error: { code, message } });
  }

  private onLine(value: unknown): void {
    if (!isRec(value)) return;
    try {
      const method = str(value.method);
      const id = value.id;
      const hasId = typeof id === 'string' || typeof id === 'number';
      if (method && hasId) this.onServerRequest(id, method, rec(value.params));
      else if (method) this.onNotification(method, rec(value.params));
      else if (typeof id === 'number') {
        const w = this.waiters.get(id);
        if (!w) return;
        this.waiters.delete(id);
        if (isRec(value.error)) w.reject(new Error(str(value.error.message) ?? 'request failed'));
        else w.resolve(value.result);
      }
    } catch (e) {
      console.error('[codex] failed to handle message:', e);
    }
  }

  // ------------------------------------------------------- notifications

  private upsertItem(item: ChatItem): void {
    this.items.set(item.id, item);
    this.events.upsert(item);
  }

  /**
   * A collab call (collabAgentToolCall: spawnAgent, sendInput, wait, closeAgent...).
   * The call that starts a sub-agent is its card; later calls about the same
   * agent update that card (running, done with the agent's last message, failed)
   * and are not cards of their own. Returns false when there is no card to update.
   */
  private onCollab(it: Rec): boolean {
    const receivers = arr(it.receiverThreadIds)
      .map((t) => str(t))
      .filter((t): t is string => t !== undefined);
    const states = rec(it.agentsStates);
    const known = receivers.filter((t) => this.subThreads.has(t));
    const id = str(it.id);
    if (it.tool === 'spawnAgent' || known.length === 0) {
      if (id) for (const t of receivers) if (!this.subThreads.has(t)) this.subThreads.set(t, id);
      if (it.tool !== 'spawnAgent') return false;
    }
    for (const thread of receivers) {
      const cardId = this.subThreads.get(thread);
      const card = cardId === undefined ? undefined : this.items.get(cardId);
      if (card?.kind !== 'tool') continue;
      const state = rec(states[thread]);
      const s = str(state.status);
      const message = str(state.message);
      const status: ToolStatus =
        s === 'completed' || s === 'shutdown'
          ? 'done'
          : s === 'errored' || s === 'notFound'
            ? 'error'
            : s === undefined
              ? card.status
              : 'running';
      const output = message && status !== 'running' ? truncateOutput(message) : undefined;
      this.upsertItem({
        ...card,
        status,
        ...(output ? { output: output.output, ...(output.truncated ? { outputTruncated: true } : {}) } : {}),
      });
    }
    return it.tool !== 'spawnAgent';
  }

  /** What a sub-agent's thread reports: its commands, edits, messages and thinking go inside its card. */
  private onSubNotification(method: string, p: Rec, parentId: string): void {
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const it = rec(p.item);
        const id = str(it.id);
        if (!id) return;
        if (it.type === 'collabAgentToolCall' && this.onCollab(it)) return;
        const prev = this.items.get(id);
        const mapped = mapThreadItem(it, this.opts.cwd, { prev, ts: Date.now(), history: false });
        if (!mapped || (mapped.kind !== 'tool' && mapped.kind !== 'text' && mapped.kind !== 'thinking'))
          return;
        // Messages arrive whole when they complete: no half-written rows inside the card.
        if (mapped.kind !== 'tool') {
          if (method !== 'item/completed' || mapped.text === '') return;
          mapped.streaming = false;
        }
        if (prev?.kind === 'tool' && mapped.kind === 'tool' && prev.images) mapped.images = prev.images;
        this.upsertItem({
          ...mapped,
          parentId: mapped.kind === 'tool' ? (mapped.parentId ?? parentId) : parentId,
        });
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const id = str(p.itemId);
        const cur = id ? this.items.get(id) : undefined;
        if (cur?.kind !== 'tool') return;
        const { output, truncated } = truncateOutput((cur.output ?? '') + (str(p.delta) ?? ''));
        this.upsertItem({ ...cur, output, ...(truncated ? { outputTruncated: true } : {}) });
        return;
      }
      default:
        return; // the sub-agent's turns, token counts and deltas are its own
    }
  }

  private onNotification(method: string, p: Rec): void {
    if (p.threadId !== undefined && this.threadId && p.threadId !== this.threadId) {
      // Another thread: a sub-agent's, when one of our collab calls started it.
      const parent = this.subThreads.get(str(p.threadId) ?? '');
      if (parent !== undefined) this.onSubNotification(method, p, parent);
      return;
    }
    switch (method) {
      case 'turn/started': {
        const turn = rec(p.turn);
        this.turnId = str(turn.id) ?? this.turnId;
        if (!this.status.turnActive) this.beginTurn();
        return;
      }
      case 'turn/completed':
        this.onTurnCompleted(rec(p.turn));
        return;
      case 'item/started':
      case 'item/completed': {
        const it = rec(p.item);
        const id = str(it.id);
        if (!id) return;
        if (it.type === 'fileChange') this.fileChanges.set(id, it.changes);
        if (it.type === 'collabAgentToolCall' && this.onCollab(it)) return;
        const prev = this.items.get(id);
        const mapped = mapThreadItem(it, this.opts.cwd, { prev, ts: Date.now(), history: false });
        if (!mapped) return;
        if (method === 'item/completed' && (mapped.kind === 'text' || mapped.kind === 'thinking'))
          mapped.streaming = false;
        // Keep a denied status we set when the user declined.
        if (
          prev?.kind === 'tool' &&
          prev.status === 'denied' &&
          mapped.kind === 'tool' &&
          mapped.status !== 'running'
        )
          mapped.status = 'denied';
        if (prev?.kind === 'tool' && mapped.kind === 'tool' && prev.images) mapped.images = prev.images;
        // A sub-agent's card stays open until a later call says how the agent ended (or the turn does).
        if (it.type === 'collabAgentToolCall' && mapped.kind === 'tool' && mapped.status === 'done') {
          mapped.status = prev?.kind === 'tool' && prev.status !== 'running' ? prev.status : 'running';
          if (prev?.kind === 'tool' && prev.output !== undefined) mapped.output = prev.output;
        }
        if (method === 'item/completed') this.attachImages(it, mapped);
        this.upsertItem(mapped);
        if (it.type === 'collabAgentToolCall') this.onCollab(it);
        return;
      }
      case 'item/agentMessage/delta':
        this.appendText(str(p.itemId), str(p.delta), 'text');
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.appendText(str(p.itemId), str(p.delta), 'thinking');
        return;
      case 'item/reasoning/summaryPartAdded': {
        const id = str(p.itemId);
        const cur = id ? this.items.get(id) : undefined;
        if (cur?.kind === 'thinking' && cur.text) this.appendText(id, '\n\n', 'thinking');
        return;
      }
      case 'item/plan/delta':
        return; // the completed plan item carries the full text
      case 'item/commandExecution/outputDelta': {
        const id = str(p.itemId);
        const cur = id ? this.items.get(id) : undefined;
        if (cur?.kind !== 'tool') return;
        const raw = (cur.output ?? '') + (str(p.delta) ?? '');
        const { output, truncated } = truncateOutput(raw);
        this.upsertItem({ ...cur, output, ...(truncated ? { outputTruncated: true } : {}) });
        return;
      }
      case 'turn/plan/updated': {
        const todos = arr(p.plan)
          .map(rec)
          .map((s) => {
            const st = str(s.status);
            const status: 'pending' | 'in_progress' | 'completed' =
              st === 'completed' ? 'completed' : st === 'inProgress' ? 'in_progress' : 'pending';
            return { text: str(s.step) ?? '', status };
          });
        const active = todos.find((t) => t.status === 'in_progress');
        const done = todos.filter((t) => t.status === 'completed').length;
        const id = `plan:${str(p.turnId) ?? this.turnId ?? 'turn'}`;
        const prev = this.items.get(id);
        const item: ToolItem = {
          kind: 'tool',
          id,
          ts: prev?.ts ?? Date.now(),
          name: 'Todo',
          title: active ? oneLine(active.text, 60) : `${done}/${todos.length} done`,
          status: 'done',
          input: { explanation: p.explanation, plan: p.plan },
          detail: { type: 'todos', todos },
        };
        this.upsertItem(item);
        return;
      }
      case 'thread/tokenUsage/updated': {
        const total = rec(rec(p.tokenUsage).total);
        this.tokensNow = { input: num(total.inputTokens) ?? 0, output: num(total.outputTokens) ?? 0 };
        if (this.tokensAtTurnStart === null) {
          const last = rec(rec(p.tokenUsage).last);
          this.tokensAtTurnStart = {
            input: this.tokensNow.input - (num(last.inputTokens) ?? 0),
            output: this.tokensNow.output - (num(last.outputTokens) ?? 0),
          };
        }
        return;
      }
      case 'error': {
        const err = rec(p.error);
        const msg = str(err.message) ?? 'Unknown error';
        const details = str(err.additionalDetails);
        if (p.willRetry === true)
          this.notice('warn', `${msg}${details ? ` (${oneLine(details, 160)})` : ''}`, 'retry');
        else this.notice('error', details ? `${msg}\n${details}` : msg);
        return;
      }
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
      case 'guardianWarning': {
        const text = str(p.message) ?? str(p.summary);
        if (text) this.notice('warn', text, `w:${text.slice(0, 40)}`);
        return;
      }
      case 'thread/compacted':
        this.notice('info', 'Conversation compacted');
        return;
      case 'model/rerouted': {
        const to = str(p.toModel) ?? str(p.model);
        if (to) {
          this.model = to;
          this.events.meta({ model: to });
          this.notice('info', `Switched to ${to}`);
        }
        return;
      }
      case 'thread/name/updated': {
        const name = str(p.threadName) ?? str(p.name);
        if (name) this.events.meta({ title: name });
        return;
      }
      case 'serverRequest/resolved': {
        const key = String(p.requestId);
        const itemId = this.byRpc.get(key);
        if (itemId) this.settle(itemId, 'cancelled');
        return;
      }
      case 'thread/status/changed': {
        if (rec(p.status).type === 'systemError')
          this.notice('error', 'Codex reported a system error for this thread.');
        return;
      }
      default:
        return; // many informational notifications; ignored on purpose
    }
  }

  private appendText(itemId: string | undefined, delta: string | undefined, kind: 'text' | 'thinking'): void {
    if (!itemId || !delta) return;
    const cur = this.items.get(itemId);
    if (cur && (cur.kind === 'text' || cur.kind === 'thinking')) {
      cur.text += delta;
      this.events.delta(itemId, delta);
      return;
    }
    const item: ChatItem = { kind, id: itemId, ts: Date.now(), text: delta, streaming: true };
    this.upsertItem(item);
  }

  private beginTurn(): void {
    this.status.turnActive = true;
    this.turnStartedAt = Date.now();
    if (this.tokensAtTurnStart !== null) this.tokensAtTurnStart = { ...this.tokensNow };
    this.status.emit();
  }

  private finishOpenItems(outcome: 'completed' | 'interrupted' | 'error'): void {
    for (const item of this.items.values()) {
      if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) {
        this.upsertItem({ ...item, streaming: false });
      } else if (item.kind === 'tool' && item.status === 'running' && outcome !== 'completed') {
        this.upsertItem({
          ...item,
          status: 'error',
          output: item.output || (outcome === 'interrupted' ? 'Interrupted' : 'Failed'),
        });
      }
    }
  }

  private onTurnCompleted(turn: Rec): void {
    const s = str(turn.status);
    const outcome: TurnItem['outcome'] =
      s === 'interrupted' || this.interruptRequested ? 'interrupted' : s === 'failed' ? 'error' : 'completed';
    this.cancelAllPending();
    this.finishOpenItems(outcome);
    const err = str(rec(turn.error).message);
    const base = this.tokensAtTurnStart ?? this.tokensNow;
    const input = this.tokensNow.input - base.input;
    const output = this.tokensNow.output - base.output;
    this.events.upsert({
      kind: 'turn',
      id: `turn:${str(turn.id) ?? randomUUID()}`,
      ts: Date.now(),
      outcome,
      durationMs: num(turn.durationMs) ?? Date.now() - this.turnStartedAt,
      ...(input > 0 ? { inputTokens: input } : {}),
      ...(output > 0 ? { outputTokens: output } : {}),
      ...(outcome === 'error' ? { error: err ?? 'Turn failed' } : {}),
    });
    this.tokensAtTurnStart = { ...this.tokensNow };
    this.turnId = undefined;
    this.interruptRequested = false;
    this.status.turnActive = false;
    this.status.emit();
  }

  // ---------------------------------------------------- server requests

  private onServerRequest(rpcId: string | number, method: string, p: Rec): void {
    const ts = Date.now();
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval': {
        const rawCmd = str(p.command) ?? arr(p.command).map(String).join(' ');
        const command = unwrapShell(rawCmd);
        const cwd = str(p.cwd) ?? this.opts.cwd;
        const reason = str(p.reason);
        const itemId = str(p.itemId) ?? str(p.callId) ?? String(rpcId);
        const item: PermissionItem = {
          kind: 'permission',
          id: `perm:${itemId}:${String(rpcId)}`,
          ts,
          toolName: 'Bash',
          title: reason
            ? `Run ${oneLine(command, 60)}? ${oneLine(reason, 80)}`
            : `Run ${oneLine(command, 80)}`,
          input: p,
          detail: { type: 'command', command, cwd },
          status: 'pending',
          canAllowAlways: true,
        };
        this.addPending({ rpcId, method, item });
        return;
      }
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval': {
        const itemId = str(p.itemId) ?? str(p.callId) ?? String(rpcId);
        let changes = this.fileChanges.get(itemId);
        if (!changes && isRec(p.fileChanges)) {
          // legacy shape: { path: {type, content|unified_diff, move_path} }
          changes = Object.entries(p.fileChanges).map(([path, fc]) => {
            const c = rec(fc);
            return {
              path,
              kind: { type: str(c.type) ?? 'update', move_path: str(c.move_path) ?? null },
              diff: str(c.unified_diff) ?? str(c.content) ?? '',
            };
          });
        }
        const { detail, title } = fileChangeDetail(changes ?? [], this.opts.cwd);
        const reason = str(p.reason);
        const item: PermissionItem = {
          kind: 'permission',
          id: `perm:${itemId}:${String(rpcId)}`,
          ts,
          toolName: 'Edit',
          title: `Edit ${title || 'files'}${reason ? ` (${oneLine(reason, 60)})` : ''}`,
          input: p,
          detail,
          status: 'pending',
          canAllowAlways: true,
        };
        this.addPending({ rpcId, method, item });
        return;
      }
      case 'item/permissions/requestApproval': {
        const perms = rec(p.permissions);
        const parts: string[] = [];
        if (rec(perms.network).enabled) parts.push('network access');
        const fsPerm = rec(perms.fileSystem);
        const writes = arr(fsPerm.write).map(String);
        const reads = arr(fsPerm.read).map(String);
        if (writes.length) parts.push(`write ${writes.join(', ')}`);
        if (reads.length) parts.push(`read ${reads.join(', ')}`);
        const item: PermissionItem = {
          kind: 'permission',
          id: `perm:${str(p.itemId) ?? ''}:${String(rpcId)}`,
          ts,
          toolName: 'Permissions',
          title: `Grant ${parts.join(' and ') || 'additional permissions'}${str(p.reason) ? `: ${oneLine(str(p.reason) ?? '', 80)}` : ''}`,
          input: p,
          status: 'pending',
          canAllowAlways: true,
        };
        this.addPending({ rpcId, method, item });
        return;
      }
      case 'item/tool/requestUserInput': {
        const questionIds = new Map<string, string>();
        const item: QuestionItem = {
          kind: 'question',
          id: `q:${str(p.itemId) ?? ''}:${String(rpcId)}`,
          ts,
          status: 'pending',
          questions: arr(p.questions)
            .map(rec)
            .map((q) => {
              const question = toQuestion(q, false);
              questionIds.set(question.question, str(q.id) ?? question.question);
              return question;
            }),
        };
        this.addPending({ rpcId, method, item, questionIds });
        return;
      }
      case 'mcpServer/elicitation/request':
        this.reply(rpcId, { action: 'decline', content: null });
        this.notice('info', 'An MCP server asked for input; phone-code declined it (not supported yet).');
        return;
      default:
        // item/tool/call, account/chatgptAuthTokens/refresh, attestation/generate, future requests
        this.replyError(rpcId, `phone-code does not handle ${method}`);
        return;
    }
  }

  private addPending(p: PendingRequest): void {
    this.pending.set(p.item.id, p);
    this.byRpc.set(String(p.rpcId), p.item.id);
    this.status.pending.add(p.item.id);
    this.events.upsert(p.item);
    this.status.emit();
  }

  private settle(
    itemId: string,
    status: 'allowed' | 'denied' | 'cancelled' | 'answered',
    answers?: Record<string, string>,
  ): PendingRequest | undefined {
    const p = this.pending.get(itemId);
    if (!p) return undefined;
    this.pending.delete(itemId);
    this.byRpc.delete(String(p.rpcId));
    this.status.pending.delete(itemId);
    if (p.item.kind === 'question') {
      p.item = {
        ...p.item,
        status: status === 'answered' ? 'answered' : 'cancelled',
        ...(answers ? { answers } : {}),
      };
    } else {
      p.item = { ...p.item, status: status === 'answered' ? 'allowed' : status };
    }
    this.events.upsert(p.item);
    this.status.emit();
    return p;
  }

  private cancelAllPending(): void {
    for (const id of this.pending.keys()) this.settle(id, 'cancelled');
  }

  /** Answer every pending request with a refusal (outside a turn, nobody else resolves them). */
  private declineAllPending(): void {
    for (const p of this.pending.values()) {
      if (p.item.kind === 'permission') {
        this.resolvePermission(p.item.id, 'deny');
        this.events.upsert({ ...p.item, status: 'cancelled' });
      } else {
        this.settle(p.item.id, 'cancelled');
        this.reply(p.rpcId, { answers: {} });
      }
    }
  }

  resolvePermission(itemId: string, decision: PermissionDecision, message?: string): void {
    const p = this.pending.get(itemId);
    if (!p || p.item.kind !== 'permission') return;
    this.settle(itemId, decision === 'deny' ? 'denied' : 'allowed');
    const always = decision === 'allowAlways';
    switch (p.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.reply(p.rpcId, {
          decision: decision === 'deny' ? 'decline' : always ? 'acceptForSession' : 'accept',
        });
        break;
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.reply(p.rpcId, {
          decision:
            decision === 'deny'
              ? { denied: { rejection: message || 'Denied by the user' } }
              : always
                ? 'approved_for_session'
                : 'approved',
        });
        break;
      case 'item/permissions/requestApproval': {
        const requested = rec(rec(p.item.input).permissions);
        this.reply(p.rpcId, {
          permissions:
            decision === 'deny'
              ? {}
              : {
                  ...(isRec(requested.network) ? { network: requested.network } : {}),
                  ...(isRec(requested.fileSystem) ? { fileSystem: requested.fileSystem } : {}),
                },
          scope: always ? 'session' : 'turn',
        });
        break;
      }
      default:
        this.replyError(p.rpcId, 'unexpected');
    }
    if (decision === 'deny') {
      const toolId = str(rec(p.item.input).itemId);
      const tool = toolId ? this.items.get(toolId) : undefined;
      if (tool?.kind === 'tool') this.upsertItem({ ...tool, status: 'denied' });
    }
  }

  answerQuestion(itemId: string, answers: Record<string, string>): void {
    const p = this.pending.get(itemId);
    if (!p || p.item.kind !== 'question') return;
    this.settle(itemId, 'answered', answers);
    const out: Record<string, { answers: string[] }> = {};
    for (const [question, answer] of Object.entries(answers)) {
      const id = p.questionIds?.get(question) ?? question;
      out[id] = { answers: [answer] };
    }
    this.reply(p.rpcId, { answers: out });
  }

  // ------------------------------------------------------------- actions

  async send(text: string, attachments?: AgentAttachment[]): Promise<void> {
    if (this.disposed) throw new Error('Session is closed');
    if (!this.proc) {
      // Crashed earlier: start a fresh app-server on the same thread.
      this.ready = this.boot(this.threadId, false);
    }
    try {
      await this.ready;
    } catch {
      this.failTurn('Could not send: Codex is not running.');
      return;
    }
    if (!this.threadId) {
      this.failTurn('Could not send: Codex has no conversation open.');
      return;
    }
    const cmd = attachments?.length ? undefined : slashCommand(text);
    if (cmd && (await this.runCommand(cmd[0], cmd[1]))) return;
    let message = text;
    // A skill: the TUI sends a dollar mention of it in the text and the core loads the skill.
    if (cmd && this.skills.some((sk) => sk.name === cmd[0]))
      message = ['$', cmd[0], cmd[1] ? ` ${cmd[1]}` : ''].join('');
    const input: Rec[] = [];
    for (const a of attachments ?? []) {
      // Stored images reach Codex as local files (UserInput localImage), like images pasted into the TUI.
      if (a.mediaType.startsWith('image/') && a.path) input.push({ type: 'localImage', path: a.path });
      else if (a.mediaType.startsWith('image/'))
        input.push({ type: 'image', url: `data:${a.mediaType};base64,${a.data}` });
      else {
        const body = Buffer.from(a.data, 'base64').toString('utf8');
        input.push({
          type: 'text',
          text: `<attachment name="${a.name ?? 'file'}">\n${body}\n</attachment>`,
          text_elements: [],
        });
      }
    }
    input.push({ type: 'text', text: message, text_elements: [] });
    const { approvalPolicy, sandbox } = policyFor(this.mode);
    const params: Rec = { threadId: this.threadId, input };
    if (this.overridesDirty) {
      params.approvalPolicy = approvalPolicy;
      params.sandboxPolicy = SANDBOX_POLICY[sandbox];
      if (this.model) params.model = this.model;
      if (this.effort) params.effort = this.effort;
    }
    if (!this.status.turnActive) this.beginTurn();
    const proc = this.proc;
    try {
      const res = rec(await this.call('turn/start', params));
      this.turnId = str(rec(res.turn).id) ?? this.turnId;
      this.overridesDirty = false;
    } catch (e) {
      if (this.proc !== proc) return; // lost the process: lost() ended the turn
      this.failTurn(`Codex rejected the message: ${errorMessage(e)}`);
    }
  }

  /** Built-in commands mapped to app-server methods. True when `name` was one of them. */
  private async runCommand(name: string, args: string): Promise<boolean> {
    if (!this.threadId || (name !== 'compact' && name !== 'review')) return false;
    if (!this.status.turnActive) this.beginTurn();
    try {
      if (name === 'compact') await this.call('thread/compact/start', { threadId: this.threadId });
      else
        await this.call('review/start', {
          threadId: this.threadId,
          target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' },
        });
    } catch (e) {
      this.failTurn(`Codex could not run /${name}: ${errorMessage(e)}`);
    }
    return true;
  }

  /** A message that never started a turn: say why and end it as an error (the core shows it running). */
  private failTurn(text: string): void {
    this.notice('error', text);
    this.events.upsert({
      kind: 'turn',
      id: `turn:${randomUUID()}`,
      ts: Date.now(),
      outcome: 'error',
      error: text,
    });
    this.status.turnActive = false;
    this.status.emit(true);
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId || !this.proc) {
      // No turn to interrupt, but the app-server may still be asking: decline what is pending.
      this.declineAllPending();
      return;
    }
    this.interruptRequested = true;
    this.cancelAllPending();
    try {
      await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10_000);
    } catch (e) {
      this.notice('warn', `Interrupt failed: ${errorMessage(e)}`);
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    this.overridesDirty = true; // applied on the next turn/start
    this.events.meta({ permissionMode: mode });
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.overridesDirty = true;
    this.events.meta({ model });
  }

  async setEffort(effort: string): Promise<void> {
    this.effort = effort;
    this.overridesDirty = true; // turn/start's `effort` applies to this and later turns
    this.events.meta({ effort });
  }

  private notice(level: NoticeItem['level'], text: string, key?: string): void {
    const id = key ? `notice:${key}:${this.turnId ?? 'idle'}` : `notice:${++this.noticeSeq}:${Date.now()}`;
    this.events.upsert({ kind: 'notice', id, ts: Date.now(), level, text });
  }
}

/** Ask a short-lived app-server for its model list (works without credentials). */
async function probeModels(): Promise<ModelOption[] | undefined> {
  const { promise: done, resolve: resolveIds } = Promise.withResolvers<ModelOption[] | undefined>();
  const proc = spawnAgent(codexBin(), ['app-server'], {
    cwd: process.cwd(),
    env: childEnv(undefined, []),
    onLine: (v) => {
      const m = rec(v);
      if (m.id !== 2) return;
      const options = parseModels(rec(m.result).data);
      resolveIds(options.length ? options : undefined);
    },
  });
  proc.writeJson({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'phone_code', title: 'phone-code', version: CLIENT_VERSION },
      capabilities: null,
    },
  });
  proc.writeJson({ method: 'initialized' });
  proc.writeJson({ id: 2, method: 'model/list', params: {} });
  const timer = setTimeout(() => resolveIds(undefined), 5000);
  void proc.exited.then(() => resolveIds(undefined));
  const ids = await done;
  clearTimeout(timer);
  await proc.kill(200);
  return ids;
}

export function createCodexAdapter(): AgentAdapter {
  return {
    kind: 'codex',
    async detect() {
      const [out, login] = await Promise.all([
        runQuick(codexBin(), ['--version']),
        runQuick(codexBin(), ['login', 'status'], 4000, true),
      ]);
      if (out === undefined)
        return { available: false, setupHint: 'Not installed. On your computer run: npm i -g @openai/codex' };
      // `codex login status`: "Logged in using ..." or "Not logged in" (exit 1).
      const loggedOut = login !== undefined && /not logged in/i.test(login);
      const version = /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0];
      discoveredModels ??= await probeModels();
      const options = discoveredModels ?? DEFAULT_MODELS;
      return {
        available: true,
        ...(version ? { version } : {}),
        models: options.map((o) => o.id),
        modelOptions: options,
        commands: CODEX_COMMANDS,
        ...(loggedOut ? { setupHint: 'Not logged in. On your computer run `codex login`.' } : {}),
      };
    },
    async start(opts, events) {
      const session = new CodexSession(opts, events);
      await session.init();
      return session;
    },
    async listResumable(limit?: number): Promise<ResumableSession[]> {
      return listCodexResumable(limit ?? 50);
    },
  };
}
