/**
 * Generic Agent Client Protocol (ACP) adapter: the fallback for every harness
 * without a native adapter (Gemini CLI, OpenCode, Qwen Code, goose, … and any
 * agent listed in agents.json, see acp-config.ts).
 *
 * Protocol: ACP v1 (`protocolVersion: 1`), JSON-RPC 2.0 over the agent's
 * stdio, one JSON object per line. Shapes follow the stable schema shipped in
 * @agentclientprotocol/sdk 2.8.0 (schema/v1/schema.json) and the spec repo at
 * v1.20.0; the message flow was checked against Gemini CLI 0.70.0, OpenCode
 * 1.19.6 and Qwen Code 0.28.0 (initialize, auth errors, session/new, modes,
 * models, config options, session/list). The JSON-RPC layer is hand-rolled
 * like the Codex adapter's, so the daemon has no new runtime dependency.
 *
 * Flow: initialize -> session/new | session/load (replays history as
 * session/update) | session/resume -> session/prompt per message (the response
 * ends the turn), session/cancel to stop. The agent asks for approval with
 * session/request_permission and may call back into fs/* and terminal/*
 * (acp-client.ts).
 *
 * Choices:
 * - Permission options: allow -> first allow_once (else allow_always),
 *   allowAlways -> allow_always (offered only when the agent offers one),
 *   deny -> reject_once (else reject_always, else the `cancelled` outcome).
 * - Modes: an agent's own modes (legacy `modes`/session/set_mode, or a config
 *   option with category "mode") are mapped onto PermissionMode only where the
 *   meaning is clear (acp-map.ts mapModes); only the mapped ones are offered on
 *   the phone (SessionInfo.permissionModes).
 * - Models: config option with category "model" (session/set_config_option),
 *   or the never-stabilized `models` field + session/set_model that Gemini CLI
 *   still sends.
 * - Auth: an `auth_required` (-32000) error becomes a notice telling the user
 *   to log in on the computer. phone-code does not call `authenticate` for
 *   browser logins (that would open a browser on an unattended computer); it
 *   does try once an API-key method when an *_API_KEY variable is set.
 * - Messages sent while a turn runs are queued and sent as the next prompt.
 */
import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ChatItem,
  NoticeItem,
  PermissionDecision,
  PermissionItem,
  PermissionMode,
  QuestionItem,
  ResumableSession,
  TextItem,
  ThinkingItem,
  ToolItem,
  TurnItem,
  UserItem,
} from '@phone-code/protocol';
import { DAEMON_VERSION } from '../config.ts';
import type { AgentAdapter, AgentEvents, AgentSession, AgentStartOptions } from './types.ts';
import { AcpClientSide, RpcError, isClientSideMethod } from './acp-client.ts';
import type { AcpAgentConfig } from './acp-config.ts';
import { elicitContent, elicitFields, elicitQuestions, type ElicitField } from './acp-elicitation.ts';
import {
  PERMISSION_MODE_ORDER,
  blockText,
  mapModes,
  mergeToolCall,
  planTodos,
  rpcErrorText,
  selectValues,
  toolItem,
  toolView,
  type AcpChoice,
  type AcpToolState,
} from './acp-map.ts';
import {
  StatusTracker,
  arr,
  errorMessage,
  isRec,
  num,
  oneLine,
  rec,
  safeEvents,
  str,
  type Rec,
} from './shared/common.ts';
import { childEnv, runQuick, spawnAgent, type SpawnedAgent } from './shared/proc.ts';

export const ACP_PROTOCOL_VERSION = 1;
const AUTH_REQUIRED = -32000;
const REQUEST_CANCELLED = -32800;
const MAX_MODELS = 100;
const CANCEL_GRACE_MS = 15_000;

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class AcpRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    readonly data: unknown,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  rpcId: string | number;
  toolCallId: string;
  options: Rec[];
  item: PermissionItem;
}

/** One selector (modes or models) and how to change it. */
interface Selector {
  via: 'config' | 'legacy';
  configId?: string;
  choices: AcpChoice[];
  current: string | undefined;
}

/** An object's `_meta` extension field (ACP's reserved key). */
function metaOf(v: unknown): Rec {
  return rec(rec(v)['_meta']);
}

function hasCap(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

function clientCapabilities(): Rec {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    session: { notices: {}, configOptions: {} },
    // Unstable ACP form elicitation (acp-elicitation.ts); Antigravity asks its questions this way.
    elicitation: { form: {} },
  };
}

function initializeParams(): Rec {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: clientCapabilities(),
    clientInfo: { name: 'phone-code', title: 'phone-code', version: DAEMON_VERSION },
  };
}

function agentEnv(cfg: AcpAgentConfig, extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const drop = Object.keys(process.env).filter((k) => k.startsWith('PHONECODE_'));
  return childEnv({ ...cfg.env, ...extra }, drop);
}

class AcpSession implements AgentSession {
  private proc: SpawnedAgent | undefined;
  private readonly events: AgentEvents;
  private readonly status: StatusTracker;
  private readonly waiters = new Map<number, Waiter>();
  private nextId = 1;
  private ready: Promise<void> | undefined;
  private disposed = false;
  private noticeSeq = 0;

  private sessionId: string | undefined;
  private agentCaps: Rec = {};
  private authMethods: Rec[] = [];
  private needsAuth = false;
  private client: AcpClientSide | undefined;

  private readonly items = new Map<string, ChatItem>();
  private readonly tools = new Map<string, AcpToolState>();
  private readonly toolTs = new Map<string, number>();
  private readonly denied = new Set<string>();
  private readonly terminalTool = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private readonly questions = new Map<
    string,
    { rpcId: string | number; fields: ElicitField[]; item: QuestionItem }
  >();
  private text: { id: string; kind: 'text' | 'thinking'; messageId: string | undefined } | undefined;
  /** The start of an agent message, held back while it may still be the preset's error marker. */
  private held: { text: string; messageId: string | undefined } | undefined;
  /** This turn's error reply (see AcpAgentConfig.errorReplyPrefix); `last` while nothing followed it. */
  private errorReply: { id: string; text: string; messageId: string | undefined; last: boolean } | undefined;
  /** toolCallId -> id of the question card that stands for it (elicitation/create carries the toolCallId). */
  private readonly askTools = new Map<string, string>();
  private itemSeq = 0;
  /** Per-instance prefix: item ids must not collide with a transcript the core restored from disk. */
  private readonly inst = randomUUID().slice(0, 8);

  /** 'history': session/load replays into the transcript; 'drop': replay after a crash restart is ignored. */
  private replay: 'none' | 'history' | 'drop' = 'none';
  private replayUser: { item: UserItem; messageId: string | undefined } | undefined;
  private replayAgentSinceUser = false;

  private readonly queue: Array<{ text: string; attachments: Attachment[] | undefined }> = [];
  private prompting = false;
  private turnSeq = 0;
  private turnStartedAt = 0;
  private cancelRequested = false;
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  private promptRpcId: number | undefined;
  private costAtTurnStart: number | undefined;
  private costNow: number | undefined;

  private modes: Selector | undefined;
  private modeMap = new Map<PermissionMode, string>();
  private models: Selector | undefined;
  private wantMode: PermissionMode;
  private wantModel: string | undefined;

  constructor(
    private readonly cfg: AcpAgentConfig,
    private readonly opts: AgentStartOptions,
    events: AgentEvents,
  ) {
    this.events = safeEvents(events);
    this.status = new StatusTracker(this.events);
    this.wantMode = opts.permissionMode ?? 'default';
    this.wantModel = opts.model;
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    this.ready = this.boot(this.opts.resumeId, 'history');
    try {
      await this.ready;
    } catch {
      // reported through notice + status already
    }
    this.status.emit();
  }

  private async boot(resumeId: string | undefined, replay: 'history' | 'drop'): Promise<void> {
    const env = agentEnv(this.cfg, this.opts.env);
    const proc = spawnAgent(this.cfg.command, this.cfg.args, {
      cwd: this.opts.cwd,
      env,
      onLine: (v) => this.onLine(proc, v),
      onInputLost: () => this.onInputLost(proc),
    });
    this.proc = proc;
    this.status.crashed = false;
    void this.client?.dispose();
    this.client = new AcpClientSide(this.opts.cwd, env, (id, output, exitCode) =>
      this.onTerminal(id, output, exitCode),
    );
    void proc.exited.then((info) => this.onExit(proc, info));
    try {
      const init = rec(await this.call('initialize', initializeParams(), 30_000));
      const version = num(init.protocolVersion);
      if (version !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `${this.cfg.name} speaks ACP version ${version ?? '?'}; phone-code speaks version ${ACP_PROTOCOL_VERSION}`,
        );
      }
      this.agentCaps = rec(init.agentCapabilities);
      this.authMethods = arr(init.authMethods).filter(isRec);
      await this.openSession(resumeId, replay);
    } catch (e) {
      if (this.proc === proc && !this.disposed) {
        this.notice('error', `Could not start ${this.cfg.name}: ${rpcErrorText(e)}`);
        this.status.crashed = true;
        this.status.emit();
      }
      throw e;
    }
  }

  /** session/load | session/resume | session/new, with the auth_required handling. */
  private async openSession(resumeId: string | undefined, replay: 'history' | 'drop'): Promise<void> {
    const base = { cwd: this.opts.cwd, mcpServers: [] };
    const sessionCaps = rec(this.agentCaps.sessionCapabilities);
    const reopen = async (id: string): Promise<Rec | undefined> => {
      if (this.agentCaps.loadSession === true) {
        this.replay = replay;
        this.replayUser = undefined;
        this.replayAgentSinceUser = false;
        try {
          const res = rec(await this.call('session/load', { ...base, sessionId: id }, 120_000));
          return { ...res, sessionId: id };
        } finally {
          if (this.replay === 'history') this.finishReplay();
          this.replay = 'none';
        }
      }
      if (hasCap(sessionCaps.resume)) {
        const res = rec(await this.call('session/resume', { ...base, sessionId: id }, 60_000));
        return { ...res, sessionId: id };
      }
      return undefined;
    };
    const attempt = async (): Promise<Rec> => {
      if (resumeId !== undefined) {
        try {
          const res = await reopen(resumeId);
          if (res) return res;
        } catch (e) {
          if (e instanceof AcpRpcError && e.code === AUTH_REQUIRED) throw e;
          if (!this.proc) throw e;
          this.notice(
            'warn',
            `Could not reopen the earlier ${this.cfg.name} conversation (${rpcErrorText(e)}), so this is a new one: it does not remember earlier messages.`,
          );
          return rec(await this.call('session/new', base, 60_000));
        }
      }
      if (resumeId !== undefined && replay === 'history') {
        this.notice(
          'warn',
          `${this.cfg.name} cannot resume a session, so this is a new conversation: it does not remember earlier messages.`,
        );
      }
      return rec(await this.call('session/new', base, 60_000));
    };
    let res: Rec;
    try {
      res = await attempt();
    } catch (e) {
      if (!(e instanceof AcpRpcError) || e.code !== AUTH_REQUIRED) throw e;
      if (!(await this.tryApiKeyAuth())) {
        this.reportAuth(e);
        return;
      }
      try {
        res = await attempt();
      } catch (e2) {
        if (e2 instanceof AcpRpcError && e2.code === AUTH_REQUIRED) {
          this.reportAuth(e2);
          return;
        }
        throw e2;
      }
    }
    this.needsAuth = false;
    const sid = str(res.sessionId);
    if (!sid) throw new Error('the agent returned no sessionId');
    this.sessionId = sid;
    this.events.nativeSessionId(sid);
    this.applySessionState(res);
    await this.applyWanted();
    this.emitMeta();
  }

  /** One `authenticate` attempt with an API-key method, only when such a key is in the environment. */
  private async tryApiKeyAuth(): Promise<boolean> {
    const env = agentEnv(this.cfg, this.opts.env);
    const hasKey = Object.entries(env).some(([k, v]) => k.endsWith('API_KEY') && v !== undefined && v !== '');
    if (!hasKey) return false;
    const method = this.authMethods.find((m) => {
      const type = str(m.type) ?? str(metaOf(m).type);
      return (
        (type === undefined || type === 'agent') &&
        /api[-_ ]?key/i.test(`${str(m.id) ?? ''} ${str(m.name) ?? ''}`)
      );
    });
    const methodId = str(method?.id);
    if (!methodId) return false;
    try {
      await this.call('authenticate', { methodId }, 30_000);
      return true;
    } catch {
      return false;
    }
  }

  private reportAuth(e: AcpRpcError): void {
    this.needsAuth = true;
    const terminal = this.authMethods.find((m) => (str(m.type) ?? str(metaOf(m).type)) === 'terminal');
    const termArgs = arr(terminal?.args ?? metaOf(terminal).args).filter(
      (a): a is string => typeof a === 'string',
    );
    const loginArgs = terminal === undefined ? (this.cfg.loginArgs ?? []) : termArgs;
    const command = [this.cfg.command.split('/').pop() ?? this.cfg.command, ...loginArgs].join(' ');
    const hints = this.authMethods
      .map((m) => str(m.description) ?? str(m.name))
      .filter((s): s is string => !!s)
      .slice(0, 4);
    const reason = rpcErrorText(e);
    this.notice(
      'error',
      `${this.cfg.name} needs you to log in first${reason ? ` (${oneLine(reason, 160)})` : ''}. ` +
        `On your computer, run \`${command}\` in a terminal and sign in, then send your message again.` +
        (hints.length > 0 ? `\nOptions: ${hints.join('; ')}` : ''),
      'auth',
    );
    this.status.crashed = true;
    this.status.emit();
  }

  private onExit(
    proc: SpawnedAgent,
    info: { code: number | null; signal: NodeJS.Signals | null; error?: Error },
  ): void {
    let text: string;
    if (info.error && /ENOENT/.test(info.error.message)) {
      text = `${this.cfg.name} is not installed here (\`${this.cfg.command}\` was not found). Install it, or fix its command in agents.json.`;
    } else {
      const tail = oneLine(proc.stderrTail().trim().split('\n').slice(-3).join(' '), 300);
      text = `${this.cfg.name} exited unexpectedly (${info.signal ?? `code ${info.code ?? '?'}`})${tail ? `: ${tail}` : ''}`;
    }
    this.lost(proc, text);
  }

  /** The agent runs but takes no more input: drop it like a crash, so the next message starts a new one. */
  private onInputLost(proc: SpawnedAgent): void {
    if (this.proc !== proc || this.disposed) return;
    this.lost(
      proc,
      `${this.cfg.name} stopped reading its input, so phone-code stopped it. Send your message again to restart it.`,
    );
    void proc.kill();
  }

  /** The process is gone (or unusable): end the turn as an error and wait for the next message. */
  private lost(proc: SpawnedAgent, text: string): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    for (const w of this.waiters.values()) w.reject(new Error(`${this.cfg.name} exited`));
    this.waiters.clear();
    this.cancelAllPending();
    void this.client?.dispose();
    if (this.disposed) return;
    const wasActive = this.status.turnActive;
    this.finishOpenItems('error');
    this.queue.length = 0;
    this.clearCancelTimer();
    this.notice('error', text);
    if (wasActive) this.emitTurn('error', text);
    this.status.turnActive = false;
    this.status.crashed = true;
    this.status.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.clearCancelTimer();
    if (this.prompting && this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
    this.cancelAllPending();
    this.finishOpenItems('interrupted');
    const proc = this.proc;
    this.proc = undefined;
    const client = this.client;
    this.client = undefined;
    await Promise.all([proc?.kill(), client?.dispose()]);
    for (const w of this.waiters.values()) w.reject(new Error('Session is closed'));
    this.waiters.clear();
    this.status.turnActive = false;
    this.status.crashed = false;
    this.status.exited = true;
    this.status.emit();
  }

  // --------------------------------------------------------------- rpc

  /** `timeoutMs` 0 = no timeout (session/prompt lasts as long as the turn). */
  private call(
    method: string,
    params: unknown,
    timeoutMs = 60_000,
    onId?: (id: number) => void,
  ): Promise<unknown> {
    const id = this.nextId++;
    onId?.(id);
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error(`${this.cfg.name} is not running`));
        return;
      }
      // A failed write is reported through onInputLost / onExit, which reject every waiter.
      this.proc.writeJson({ jsonrpc: '2.0', id, method, params });
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiters.delete(id);
              reject(new Error(`${method} timed out`));
            }, timeoutMs)
          : undefined;
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

  private notify(method: string, params: unknown): void {
    this.proc?.writeJson({ jsonrpc: '2.0', method, params });
  }

  private reply(id: string | number, result: unknown): void {
    this.proc?.writeJson({ jsonrpc: '2.0', id, result });
  }

  private replyError(id: string | number, code: number, message: string): void {
    this.proc?.writeJson({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private onLine(proc: SpawnedAgent, value: unknown): void {
    if (!isRec(value) || proc !== this.proc) return;
    try {
      const method = str(value.method);
      const id = value.id;
      const hasId = typeof id === 'string' || typeof id === 'number';
      if (method && hasId) this.onAgentRequest(id, method, rec(value.params));
      else if (method) this.onNotification(method, rec(value.params));
      else if (typeof id === 'number') {
        const w = this.waiters.get(id);
        if (!w) return;
        this.waiters.delete(id);
        if (isRec(value.error)) {
          const err = value.error;
          w.reject(new AcpRpcError(num(err.code), err.data, rpcErrorText(err) || 'request failed'));
        } else w.resolve(value.result);
      }
    } catch (e) {
      console.error(`[acp:${this.cfg.id}] failed to handle message:`, e);
    }
  }

  // ------------------------------------------------------- notifications

  private onNotification(method: string, p: Rec): void {
    if (method !== 'session/update') return; // e.g. $/cancel_request for requests we answer at once
    if (this.replay === 'drop') return;
    const sid = str(p.sessionId);
    if (sid !== undefined && this.sessionId !== undefined && sid !== this.sessionId && this.replay === 'none')
      return;
    const u = rec(p.update);
    const kind = str(u.sessionUpdate) ?? '';
    if (this.replay === 'history' && kind !== 'user_message_chunk') this.flushReplayUser();
    switch (kind) {
      case 'user_message_chunk':
        if (this.replay === 'history') this.replayUserChunk(u);
        return; // live: the core already shows the user's message
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = blockText(u.content);
        // Gemini CLI announces a mode switch as a message chunk "[MODE_UPDATE] <modeId>".
        const modeUpdate = /^\[MODE_UPDATE\] (\S+)\s*$/.exec(text);
        if (modeUpdate?.[1] !== undefined) {
          if (this.modes && this.replay === 'none') {
            this.modes.current = modeUpdate[1];
            this.emitMeta();
          }
          return;
        }
        if (this.replay === 'history') this.replayAgentSinceUser = true;
        this.appendText(kind === 'agent_message_chunk' ? 'text' : 'thinking', text, str(u.messageId));
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (this.replay === 'history') this.replayAgentSinceUser = true;
        this.onToolUpdate(u);
        return;
      }
      case 'plan': {
        this.closeText();
        const todos = planTodos(u.entries);
        const active = todos.find((t) => t.status === 'in_progress');
        const done = todos.filter((t) => t.status === 'completed').length;
        const id = `plan:${this.inst}:${this.turnSeq}`;
        const prev = this.items.get(id);
        const item: ToolItem = {
          kind: 'tool',
          id,
          ts: prev?.ts ?? Date.now(),
          name: 'Todo',
          title: active ? oneLine(active.text, 60) : `${done}/${todos.length} done`,
          status: 'done',
          input: { entries: u.entries },
          detail: { type: 'todos', todos },
        };
        this.upsertItem(item);
        return;
      }
      case 'current_mode_update': {
        const id = str(u.currentModeId);
        if (id && this.modes) {
          this.modes.current = id;
          this.emitMeta();
        }
        return;
      }
      case 'config_option_update':
        this.applyConfigOptions(u.configOptions);
        this.emitMeta();
        return;
      case 'session_info_update': {
        const title = str(u.title);
        if (title && this.replay === 'none') this.events.meta({ title });
        return;
      }
      case 'usage_update': {
        const cost = rec(u.cost);
        const amount = num(cost.amount);
        if (amount !== undefined && str(cost.currency) === 'USD') this.costNow = amount;
        return;
      }
      case 'notice': {
        if (this.replay !== 'none') return;
        const sev = str(u.severity);
        const title = str(u.title) ?? '';
        const desc = str(u.description);
        if (title)
          this.notice(
            sev === 'error' ? 'error' : sev === 'warning' ? 'warn' : 'info',
            desc ? `${title}\n${desc}` : title,
          );
        return;
      }
      default:
        return; // available_commands_update, compaction, future variants: ignored on purpose
    }
  }

  private nextItemId(prefix: string): string {
    return `${prefix}:${this.inst}:${this.turnSeq}:${++this.itemSeq}`;
  }

  private upsertItem(item: ChatItem): void {
    this.items.set(item.id, item);
    this.events.upsert(item);
  }

  private appendText(kind: 'text' | 'thinking', delta: string, messageId: string | undefined): void {
    if (!delta) return;
    const same = (a: string | undefined): boolean => a === undefined || messageId === undefined || a === messageId;
    if (this.held) {
      if (kind === 'text' && same(this.held.messageId)) {
        this.held.text += delta;
        this.settleHeld(false);
        return;
      }
      this.settleHeld(true);
    }
    const err = this.errorReply;
    if (err?.last && this.text === undefined) {
      if (kind === 'text' && same(err.messageId)) {
        err.text += delta;
        this.upsertItem({ kind: 'notice', id: err.id, ts: Date.now(), level: 'error', text: err.text.trim() });
        return;
      }
      err.last = false;
    }
    const marker = this.cfg.errorReplyPrefix;
    if (kind === 'text' && marker !== undefined && this.replay === 'none' && this.text?.kind !== 'text') {
      // A new agent message: it may be the agent's way of reporting a failure.
      this.closeText();
      this.held = { text: delta, messageId };
      this.settleHeld(false);
      return;
    }
    this.streamText(kind, delta, messageId);
  }

  /**
   * Decide about held-back text: an error notice once it starts with the
   * marker, ordinary text once it cannot (or when `flush`: something else came).
   */
  private settleHeld(flush: boolean): void {
    const held = this.held;
    const marker = this.cfg.errorReplyPrefix;
    if (!held || marker === undefined) return;
    const start = held.text.trimStart();
    if (start.startsWith(marker)) {
      this.held = undefined;
      const id = this.nextItemId('notice');
      this.errorReply = { id, text: held.text, messageId: held.messageId, last: true };
      this.upsertItem({ kind: 'notice', id, ts: Date.now(), level: 'error', text: held.text.trim() });
      return;
    }
    if (!flush && marker.startsWith(start)) return; // still undecided
    this.held = undefined;
    this.streamText('text', held.text, held.messageId);
  }

  private streamText(kind: 'text' | 'thinking', delta: string, messageId: string | undefined): void {
    const cur = this.text;
    if (
      cur &&
      cur.kind === kind &&
      (messageId === undefined || cur.messageId === undefined || cur.messageId === messageId)
    ) {
      const item = this.items.get(cur.id);
      if (item && (item.kind === 'text' || item.kind === 'thinking')) {
        item.text += delta;
        if (cur.messageId === undefined && messageId !== undefined) cur.messageId = messageId;
        this.events.delta(cur.id, delta);
        return;
      }
    }
    this.closeText();
    const id = this.nextItemId(kind);
    const item: TextItem | ThinkingItem = { kind, id, ts: Date.now(), text: delta, streaming: true };
    this.text = { id, kind, messageId };
    this.upsertItem(item);
  }

  private closeText(): void {
    this.settleHeld(true);
    if (this.errorReply) this.errorReply.last = false;
    const cur = this.text;
    this.text = undefined;
    if (!cur) return;
    const item = this.items.get(cur.id);
    if (item && (item.kind === 'text' || item.kind === 'thinking') && item.streaming)
      this.upsertItem({ ...item, streaming: false });
  }

  private onToolUpdate(u: Rec): void {
    const id = str(u.toolCallId);
    if (!id) return;
    this.closeText();
    const state = mergeToolCall(this.tools.get(id), u);
    for (const c of state.content) {
      const term = str(c.terminalId);
      if (c.type === 'terminal' && term) this.terminalTool.set(term, id);
    }
    this.tools.set(id, state);
    this.renderTool(id);
  }

  private toolItemId(toolCallId: string): string {
    return `tool:${this.inst}:${toolCallId}`;
  }

  private renderTool(toolCallId: string): void {
    const state = this.tools.get(toolCallId);
    if (!state) return;
    let ts = this.toolTs.get(toolCallId);
    if (ts === undefined) {
      ts = Date.now();
      this.toolTs.set(toolCallId, ts);
    }
    const item = toolItem(state, this.toolItemId(toolCallId), this.opts.cwd, ts, {
      denied: this.denied.has(toolCallId),
    });
    // The question card is this tool call's UI: nest the generic row under it, where it is not shown.
    const ask = this.askTools.get(toolCallId);
    this.upsertItem(ask === undefined ? item : { ...item, parentId: ask });
  }

  private onTerminal(terminalId: string, output: string, exitCode: number | null | undefined): void {
    const toolCallId = this.terminalTool.get(terminalId);
    const state = toolCallId ? this.tools.get(toolCallId) : undefined;
    if (!toolCallId || !state) return;
    state.terminalOutput ??= new Map();
    const prev = state.terminalOutput.get(terminalId);
    state.terminalOutput.set(terminalId, {
      output,
      ...(exitCode !== undefined
        ? { exitCode }
        : prev?.exitCode !== undefined
          ? { exitCode: prev.exitCode }
          : {}),
    });
    this.renderTool(toolCallId);
  }

  // -------------------------------------------------------------- replay

  /** Replayed user chunks are buffered until the message is complete, so context preambles can be dropped. */
  private replayUserChunk(u: Rec): void {
    this.closeText();
    const text = blockText(u.content);
    const messageId = str(u.messageId);
    const cur = this.replayUser;
    if (cur && (messageId === undefined || cur.messageId === undefined || cur.messageId === messageId)) {
      cur.item = { ...cur.item, text: cur.item.text + text };
      return;
    }
    this.flushReplayUser();
    if (this.replayAgentSinceUser) this.emitTurn('completed');
    this.replayAgentSinceUser = false;
    this.replayUser = { item: { kind: 'user', id: '', ts: Date.now(), text }, messageId };
  }

  private flushReplayUser(): void {
    const cur = this.replayUser;
    this.replayUser = undefined;
    if (!cur) return;
    // Context the agent injected itself (Gemini CLI: one message wrapped in <session_context>…</session_context>).
    if (/^\s*<([a-z_]+)>[\s\S]*<\/\1>\s*$/.test(cur.item.text)) return;
    if (this.replayAgentSinceUser) this.emitTurn('completed');
    this.replayAgentSinceUser = false;
    this.turnSeq += 1;
    this.upsertItem({ ...cur.item, id: this.nextItemId('user') });
  }

  private finishReplay(): void {
    this.closeText();
    for (const [id, t] of this.tools) {
      if (t.status === 'pending' || t.status === 'in_progress') {
        t.status = 'failed';
        this.renderTool(id);
      }
    }
    this.flushReplayUser();
    if (this.replayAgentSinceUser) this.emitTurn('completed');
    this.replayAgentSinceUser = false;
  }

  // ---------------------------------------------------- agent -> client

  private onAgentRequest(rpcId: string | number, method: string, p: Rec): void {
    if (method === 'session/request_permission') {
      this.onPermissionRequest(rpcId, p);
      return;
    }
    if (method === 'elicitation/create') {
      this.onElicitation(rpcId, p);
      return;
    }
    if (isClientSideMethod(method) && this.client) {
      const client = this.client;
      client.handle(method, p).then(
        (result) => this.reply(rpcId, result),
        (e: unknown) => {
          if (e instanceof RpcError) this.replyError(rpcId, e.code, e.message);
          else this.replyError(rpcId, -32603, errorMessage(e));
        },
      );
      return;
    }
    this.replyError(rpcId, -32601, `phone-code does not implement ${method}`);
  }

  private onPermissionRequest(rpcId: string | number, p: Rec): void {
    const tc = rec(p.toolCall);
    const toolCallId = str(tc.toolCallId) ?? `perm-${String(rpcId)}`;
    this.closeText();
    const state = mergeToolCall(this.tools.get(toolCallId), { ...tc, toolCallId });
    const known = this.tools.has(toolCallId);
    this.tools.set(toolCallId, state);
    if (known || state.title) this.renderTool(toolCallId);
    const options = arr(p.options).filter(isRec);
    const view = toolView(state, this.opts.cwd);
    const item: PermissionItem = {
      kind: 'permission',
      id: `perm:${this.inst}:${toolCallId}:${String(rpcId)}`,
      ts: Date.now(),
      toolName: view.name,
      title: view.name === 'Bash' ? `Run ${view.title}` : state.title || view.title,
      ...(state.rawInput !== undefined ? { input: state.rawInput } : {}),
      ...(view.detail ? { detail: view.detail } : {}),
      status: 'pending',
      canAllowAlways: options.some((o) => o.kind === 'allow_always'),
      canDenyWithMessage: false,
    };
    this.pending.set(item.id, { rpcId, toolCallId, options, item });
    this.status.pending.add(item.id);
    this.events.upsert(item);
    this.status.emit();
  }

  private settle(itemId: string, status: PermissionItem['status']): Pending | undefined {
    const p = this.pending.get(itemId);
    if (!p) return undefined;
    this.pending.delete(itemId);
    this.status.pending.delete(itemId);
    p.item = { ...p.item, status };
    this.events.upsert(p.item);
    this.status.emit();
    return p;
  }

  private cancelAllPending(): void {
    for (const id of this.pending.keys()) {
      const p = this.settle(id, 'cancelled');
      if (p) this.reply(p.rpcId, { outcome: { outcome: 'cancelled' } });
    }
    for (const id of this.questions.keys()) {
      const q = this.settleQuestion(id, 'cancelled');
      if (q) this.reply(q.rpcId, { action: 'cancel' });
    }
  }

  /** A form elicitation becomes a QuestionItem; URL mode and empty forms are declined. */
  private onElicitation(rpcId: string | number, p: Rec): void {
    const fields = str(p.mode) === 'url' ? undefined : elicitFields(p.requestedSchema);
    if (!fields) {
      this.reply(rpcId, { action: 'decline' });
      return;
    }
    this.closeText();
    const item: QuestionItem = {
      kind: 'question',
      id: `question:${this.inst}:${String(rpcId)}`,
      ts: Date.now(),
      questions: elicitQuestions(fields, str(p.message)),
      status: 'pending',
    };
    this.questions.set(item.id, { rpcId, fields, item });
    this.status.pending.add(item.id);
    this.events.upsert(item);
    // Antigravity also shows the asking tool call ("Run ask_question"); the card replaces it.
    const toolCallId = str(p.toolCallId);
    if (toolCallId !== undefined) {
      this.askTools.set(toolCallId, item.id);
      this.renderTool(toolCallId);
    }
    this.status.emit();
  }

  private settleQuestion(itemId: string, status: QuestionItem['status'], answers?: Record<string, string>) {
    const q = this.questions.get(itemId);
    if (!q) return undefined;
    this.questions.delete(itemId);
    this.status.pending.delete(itemId);
    this.events.upsert({ ...q.item, status, ...(answers ? { answers } : {}) });
    this.status.emit();
    return q;
  }

  resolvePermission(itemId: string, decision: PermissionDecision, _message?: string): void {
    const p = this.pending.get(itemId);
    if (!p) return;
    const pick = (...kinds: string[]): string | undefined => {
      for (const k of kinds) {
        const o = p.options.find((x) => x.kind === k);
        const id = str(o?.optionId);
        if (id) return id;
      }
      return undefined;
    };
    const optionId =
      decision === 'deny'
        ? pick('reject_once', 'reject_always')
        : decision === 'allowAlways'
          ? pick('allow_always', 'allow_once')
          : pick('allow_once', 'allow_always');
    this.settle(itemId, decision === 'deny' ? 'denied' : 'allowed');
    this.reply(
      p.rpcId,
      optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
    );
    if (decision === 'deny') {
      this.denied.add(p.toolCallId);
      if (this.items.has(this.toolItemId(p.toolCallId))) this.renderTool(p.toolCallId);
    }
  }

  answerQuestion(itemId: string, answers: Record<string, string>): void {
    const q = this.settleQuestion(itemId, 'answered', answers);
    if (q) this.reply(q.rpcId, { action: 'accept', content: elicitContent(q.fields, answers) });
  }

  // ------------------------------------------------------------- turns

  private beginTurn(): void {
    this.turnSeq += 1;
    this.held = undefined;
    this.errorReply = undefined;
    if (this.proc) this.status.crashed = false;
    this.turnStartedAt = Date.now();
    this.costAtTurnStart = this.costNow;
    this.cancelRequested = false;
    this.status.turnActive = true;
    this.status.emit();
  }

  private emitTurn(outcome: TurnItem['outcome'], error?: string, usage?: Rec): void {
    const live = this.replay === 'none';
    const cost =
      live && this.costNow !== undefined && this.costAtTurnStart !== undefined
        ? this.costNow - this.costAtTurnStart
        : undefined;
    const input = num(usage?.inputTokens);
    const output = num(usage?.outputTokens);
    this.events.upsert({
      kind: 'turn',
      id: `turn:${this.turnSeq}:${randomUUID().slice(0, 8)}`,
      ts: Date.now(),
      outcome,
      ...(live ? { durationMs: Date.now() - this.turnStartedAt } : {}),
      ...(cost !== undefined && cost > 0 ? { costUsd: cost } : {}),
      ...(input !== undefined && input > 0 ? { inputTokens: input } : {}),
      ...(output !== undefined && output > 0 ? { outputTokens: output } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  private finishOpenItems(outcome: 'completed' | 'interrupted' | 'error'): void {
    this.closeText();
    for (const [id, t] of this.tools) {
      if ((t.status === 'pending' || t.status === 'in_progress') && outcome !== 'completed') {
        t.status = 'failed';
        if (t.content.length === 0 && t.rawOutput === undefined)
          t.rawOutput = outcome === 'interrupted' ? 'Interrupted' : 'Failed';
        this.renderTool(id);
      }
    }
  }

  private clearCancelTimer(): void {
    if (this.cancelTimer !== undefined) clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
  }

  private buildPrompt(text: string, attachments: Attachment[] | undefined): Rec[] {
    const caps = rec(this.agentCaps.promptCapabilities);
    const blocks: Rec[] = [];
    let droppedImages = 0;
    for (const a of attachments ?? []) {
      if (a.mediaType.startsWith('image/')) {
        if (caps.image === true) blocks.push({ type: 'image', mimeType: a.mediaType, data: a.data });
        else droppedImages++;
        continue;
      }
      const body = Buffer.from(a.data, 'base64').toString('utf8');
      const name = a.name ?? 'attachment.txt';
      if (caps.embeddedContext === true) {
        blocks.push({
          type: 'resource',
          resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: a.mediaType, text: body },
        });
      } else blocks.push({ type: 'text', text: `<attachment name="${name}">\n${body}\n</attachment>` });
    }
    if (droppedImages > 0)
      this.notice(
        'warn',
        `${this.cfg.name} does not accept images, so ${droppedImages === 1 ? 'the photo was' : 'the photos were'} not sent.`,
      );
    blocks.push({ type: 'text', text });
    return blocks;
  }

  private async pump(): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const next = this.queue.shift();
        if (!next) break;
        // oxlint-disable-next-line no-await-in-loop -- prompts run one after another
        await this.runPrompt(next.text, next.attachments);
      }
    } finally {
      this.prompting = false;
      this.status.turnActive = false;
      // Forced: after a failed restart the status is `error` again, but the core shows `running`.
      this.status.emit(true);
    }
  }

  private async runPrompt(text: string, attachments: Attachment[] | undefined): Promise<void> {
    this.beginTurn();
    if (!this.proc) this.ready = this.boot(this.sessionId, 'drop');
    try {
      await this.ready;
    } catch {
      this.emitTurn('error', `${this.cfg.name} is not running`);
      return;
    }
    if (!this.sessionId && this.proc) {
      // Not logged in earlier (or session/new failed): try again now.
      try {
        await this.openSession(undefined, 'drop');
      } catch (e) {
        this.notice('error', `Could not start a ${this.cfg.name} session: ${rpcErrorText(e)}`);
      }
    }
    const sessionId = this.sessionId;
    if (!sessionId) {
      this.emitTurn('error', this.needsAuth ? 'Not logged in' : `${this.cfg.name} has no session`);
      return;
    }
    this.status.crashed = false;
    this.status.emit();
    const prompt = this.buildPrompt(text, attachments);
    let outcome: TurnItem['outcome'] = 'completed';
    let error: string | undefined;
    let usage: Rec | undefined;
    try {
      const res = rec(
        await this.call('session/prompt', { sessionId, prompt }, 0, (id) => {
          this.promptRpcId = id;
        }),
      );
      usage = rec(res.usage);
      const stop = str(res.stopReason);
      if (stop === 'cancelled' || this.cancelRequested) outcome = 'interrupted';
      else if (stop === 'refusal') {
        outcome = 'error';
        error = `${this.cfg.name} refused to continue`;
      } else if (stop === 'max_tokens' || stop === 'max_turn_requests') {
        this.notice(
          'warn',
          stop === 'max_tokens' ? 'The reply hit the token limit.' : 'The turn hit the request limit.',
        );
      }
    } catch (e) {
      if (this.cancelRequested || (e instanceof AcpRpcError && e.code === REQUEST_CANCELLED))
        outcome = 'interrupted';
      else if (e instanceof AcpRpcError && e.code === AUTH_REQUIRED) {
        this.reportAuth(e);
        outcome = 'error';
        error = 'Not logged in';
      } else if (!this.proc) {
        return; // crashed: onExit already reported it
      } else {
        outcome = 'error';
        error = rpcErrorText(e);
        this.notice('error', `${this.cfg.name}: ${error}`);
      }
    } finally {
      this.promptRpcId = undefined;
      this.clearCancelTimer();
    }
    this.cancelAllPending();
    this.settleHeld(true);
    if (outcome === 'completed' && this.errorReply?.last) {
      // The agent reported a failure as its reply (errorReplyPrefix) and ended the turn.
      outcome = 'error';
      error = oneLine(this.errorReply.text.trim().slice(this.cfg.errorReplyPrefix?.length ?? 0).trim(), 300);
    }
    this.finishOpenItems(outcome);
    this.emitTurn(outcome, outcome === 'error' ? (error ?? 'Turn failed') : undefined, usage);
    this.cancelRequested = false;
  }

  // ------------------------------------------------------------- actions

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    if (this.disposed) throw new Error('Session is closed');
    this.queue.push({ text, attachments });
    if (!this.status.turnActive) {
      this.status.turnActive = true;
      this.status.emit();
    }
    void this.pump();
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    if (!this.prompting || !this.sessionId || !this.proc) {
      // No prompt is running, but the agent may still ask (e.g. after its turn ended).
      this.cancelAllPending();
      return;
    }
    this.cancelRequested = true;
    this.notify('session/cancel', { sessionId: this.sessionId });
    this.cancelAllPending();
    this.clearCancelTimer();
    const rpcId = this.promptRpcId;
    // An agent that never answers the cancelled prompt must not leave the session stuck.
    this.cancelTimer = setTimeout(() => {
      const w = rpcId === undefined ? undefined : this.waiters.get(rpcId);
      if (w && rpcId !== undefined) {
        this.waiters.delete(rpcId);
        this.notice('warn', `${this.cfg.name} did not confirm the stop; phone-code stopped waiting for it.`);
        w.reject(new AcpRpcError(REQUEST_CANCELLED, undefined, 'cancelled'));
      }
    }, CANCEL_GRACE_MS);
    return Promise.resolve();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.wantMode = mode;
    if (!this.sessionId) {
      this.events.meta({ permissionMode: mode });
      return;
    }
    await this.applyMode(mode, true);
    this.emitMeta();
  }

  async setModel(model: string): Promise<void> {
    this.wantModel = model;
    if (!this.sessionId) {
      this.events.meta({ model });
      return;
    }
    await this.applyModel(model);
    this.emitMeta();
  }

  // ------------------------------------------------------ modes, models

  private applySessionState(res: Rec): void {
    if (Array.isArray(res.configOptions)) this.applyConfigOptions(res.configOptions);
    if (!this.modes && isRec(res.modes)) {
      const m = res.modes;
      const choices = arr(m.availableModes)
        .map(rec)
        .map((x): AcpChoice => {
          const c: AcpChoice = { id: str(x.id) ?? '', name: str(x.name) ?? str(x.id) ?? '' };
          const description = str(x.description);
          if (description) c.description = description;
          return c;
        })
        .filter((x) => x.id !== '');
      this.modes = { via: 'legacy', choices, current: str(m.currentModeId) };
      this.modeMap = mapModes(choices, this.modes.current);
    }
    if (!this.models && isRec(res.models)) {
      const m = res.models;
      const choices = arr(m.availableModels)
        .map(rec)
        .map((x) => ({ id: str(x.modelId) ?? '', name: str(x.name) ?? str(x.modelId) ?? '' }))
        .filter((x) => x.id !== '');
      this.models = { via: 'legacy', choices, current: str(m.currentModelId) };
    }
  }

  private applyConfigOptions(options: unknown): void {
    for (const o of arr(options).map(rec)) {
      if (str(o.type) !== 'select') continue;
      const configId = str(o.id);
      if (!configId) continue;
      const cat = str(o.category);
      const choices = selectValues(o.options);
      const current = str(o.currentValue);
      if (
        cat === 'model' &&
        (!this.models || this.models.configId === configId || this.models.via === 'legacy')
      ) {
        this.models = { via: 'config', configId, choices, current };
      } else if (
        cat === 'mode' &&
        (!this.modes || this.modes.configId === configId || this.modes.via === 'legacy')
      ) {
        const initial =
          this.modes?.configId === configId ? (this.modeMap.get('default') ?? current) : current;
        this.modes = { via: 'config', configId, choices, current };
        this.modeMap = mapModes(choices, initial);
      }
    }
  }

  private async applyWanted(): Promise<void> {
    if (this.wantModel !== undefined && this.models && this.wantModel !== this.models.current) {
      if (this.models.choices.some((c) => c.id === this.wantModel)) await this.applyModel(this.wantModel);
    }
    if (this.wantMode !== 'default' || (this.modes && this.modeMap.get('default') !== this.modes.current)) {
      await this.applyMode(this.wantMode, false);
    }
  }

  private async applyMode(mode: PermissionMode, explicit: boolean): Promise<void> {
    const sessionId = this.sessionId;
    const modes = this.modes;
    if (!sessionId) return;
    const target = this.modeMap.get(mode);
    if (!modes || target === undefined) {
      if (explicit && mode !== 'default')
        this.notice(
          'info',
          `${this.cfg.name} has no mode that matches “${mode}”, so it keeps its current behaviour.`,
        );
      return;
    }
    if (target === modes.current) return;
    try {
      if (modes.via === 'config' && modes.configId) {
        const res = rec(
          await this.call('session/set_config_option', {
            sessionId,
            configId: modes.configId,
            value: target,
          }),
        );
        if (Array.isArray(res.configOptions)) this.applyConfigOptions(res.configOptions);
        else modes.current = target;
      } else {
        await this.call('session/set_mode', { sessionId, modeId: target });
        modes.current = target;
      }
    } catch (e) {
      this.notice('warn', `Could not switch ${this.cfg.name}'s mode: ${rpcErrorText(e)}`);
    }
  }

  private async applyModel(model: string): Promise<void> {
    const sessionId = this.sessionId;
    const models = this.models;
    if (!sessionId || !models) return;
    if (model === models.current) return;
    try {
      if (models.via === 'config' && models.configId) {
        const res = rec(
          await this.call('session/set_config_option', {
            sessionId,
            configId: models.configId,
            value: model,
          }),
        );
        if (Array.isArray(res.configOptions)) this.applyConfigOptions(res.configOptions);
        else models.current = model;
      } else {
        await this.call('session/set_model', { sessionId, modelId: model });
        models.current = model;
      }
    } catch (e) {
      this.notice('warn', `Could not switch ${this.cfg.name} to ${model}: ${rpcErrorText(e)}`);
    }
  }

  private emitMeta(): void {
    const reverse = new Map([...this.modeMap].map(([pm, id]) => [id, pm]));
    const current = this.modes?.current;
    const permissionMode: PermissionMode | undefined = this.modes
      ? current !== undefined
        ? reverse.get(current)
        : undefined
      : 'default';
    const permissionModes: PermissionMode[] = this.modes
      ? PERMISSION_MODE_ORDER.filter((m) => this.modeMap.has(m))
      : ['default'];
    let models: string[] | undefined;
    if (this.models) {
      models = this.models.choices.map((c) => c.id).slice(0, MAX_MODELS);
      const cur = this.models.current;
      if (cur !== undefined && !models.includes(cur)) models.unshift(cur);
    }
    this.events.meta({
      ...(this.models?.current !== undefined ? { model: this.models.current } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      permissionModes,
      ...(models !== undefined ? { models } : {}),
    });
  }

  private notice(level: NoticeItem['level'], text: string, key?: string): void {
    const id = key ? `notice:${key}:${this.inst}:${this.turnSeq}` : `notice:${this.inst}:${++this.noticeSeq}`;
    this.events.upsert({ kind: 'notice', id, ts: Date.now(), level, text });
  }
}

// ------------------------------------------------------------ adapter

/** Ask a short-lived agent process for its past sessions (`session/list`), when it can list and resume them. */
async function probeSessions(cfg: AcpAgentConfig, limit: number): Promise<ResumableSession[]> {
  const env = agentEnv(cfg, undefined);
  const waiters = new Map<number, (v: Rec) => void>();
  const proc = spawnAgent(cfg.command, cfg.args, {
    cwd: process.cwd(),
    env,
    onLine: (v) => {
      const m = rec(v);
      const id = m.id;
      if (typeof id === 'number' && m.method === undefined) waiters.get(id)?.(m);
      else if (m.method !== undefined && (typeof id === 'number' || typeof id === 'string'))
        proc.writeJson({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'not available while listing' },
        });
    },
  });
  let nextId = 1;
  const call = (method: string, params: unknown): Promise<Rec> =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      if (!proc.writeJson({ jsonrpc: '2.0', id, method, params })) resolve({});
    });
  const work = async (): Promise<ResumableSession[]> => {
    const init = rec((await call('initialize', initializeParams())).result);
    const caps = rec(init.agentCapabilities);
    const sc = rec(caps.sessionCapabilities);
    if (num(init.protocolVersion) !== ACP_PROTOCOL_VERSION || !hasCap(sc.list)) return [];
    if (caps.loadSession !== true && !hasCap(sc.resume)) return [];
    const out: ResumableSession[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && out.length < limit; page++) {
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential
      const res = rec((await call('session/list', cursor ? { cursor } : {})).result);
      for (const s of arr(res.sessions).map(rec)) {
        const resumeId = str(s.sessionId);
        const cwd = str(s.cwd);
        if (!resumeId || !cwd) continue;
        out.push({
          agent: cfg.id,
          resumeId,
          cwd,
          title: oneLine(str(s.title) ?? 'Untitled session', 120),
          updatedAt: Date.parse(str(s.updatedAt) ?? '') || 0,
        });
      }
      cursor = str(res.nextCursor);
      if (!cursor) break;
    }
    return out;
  };
  const timeout = new Promise<ResumableSession[]>((resolve) => setTimeout(() => resolve([]), 10_000));
  try {
    const list = await Promise.race([work(), timeout, proc.exited.then(() => [])]);
    return list.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  } finally {
    await proc.kill(300);
  }
}

export function createAcpAdapter(cfg: AcpAgentConfig): AgentAdapter {
  let listing: Promise<ResumableSession[]> | undefined;
  return {
    kind: cfg.id,
    name: cfg.name,
    impl: 'acp',
    source: cfg.source,
    async detect() {
      const found = Bun.which(cfg.command);
      if (found === null) return { available: false };
      if (cfg.versionArgs === null) return { available: true };
      const out = await runQuick(found, cfg.versionArgs, 4000);
      const version = out === undefined ? undefined : /\d+\.\d+(?:\.\d+)?[\w.+-]*/.exec(out)?.[0];
      return { available: true, ...(version ? { version } : {}) };
    },
    async start(opts, events) {
      const session = new AcpSession(cfg, opts, events);
      await session.init();
      return session;
    },
    listResumable(limit?: number): Promise<ResumableSession[]> {
      if (Bun.which(cfg.command) === null) return Promise.resolve([]);
      listing ??= probeSessions(cfg, limit ?? 50)
        .catch(() => [])
        .finally(() => {
          listing = undefined;
        });
      return listing;
    },
  };
}
