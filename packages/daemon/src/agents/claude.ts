/**
 * Claude Code adapter.
 *
 * Route: the CLI's own stream-json protocol over stdio, i.e. exactly what
 * @anthropic-ai/claude-agent-sdk's query() speaks, without the SDK:
 *
 *   claude --output-format stream-json --verbose --input-format stream-json
 *          --include-partial-messages --permission-prompt-tool stdio ...
 *
 * Why not the SDK: it pulls a ~360 MB platform binary as an optional dependency
 * (we use the user's installed `claude` anyway) and the daemon ships as a
 * `bun build --compile` executable; the wire protocol is small and was captured
 * from a real SDK <-> CLI session (see e2e/fakes/README.md).
 *
 * Control protocol (both directions are JSON lines):
 *   us -> cli  {type:'control_request', request_id, request:{subtype:'initialize'|'interrupt'|'set_permission_mode'|'set_model', ...}}
 *   cli -> us  {type:'control_response', response:{subtype:'success'|'error', request_id, response?, error?}}
 *   cli -> us  {type:'control_request', request_id, request:{subtype:'can_use_tool', tool_name, input, permission_suggestions, tool_use_id, ...}}
 *   us -> cli  {type:'control_response', response:{subtype:'success', request_id, response:{behavior:'allow', updatedInput, updatedPermissions?} | {behavior:'deny', message}}}
 *   cli -> us  {type:'control_cancel_request', request_id}
 *   us -> cli  {type:'user', message:{role:'user', content}, parent_tool_use_id:null, session_id:''}
 */
import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  NoticeItem,
  PermissionDecision,
  PermissionItem,
  PermissionMode,
  QuestionItem,
  ResumableSession,
  TurnItem,
} from '@phone-code/protocol';
import type { AgentAdapter, AgentEvents, AgentSession, AgentStartOptions } from './types.ts';
import { ClaudeMapper } from './claude-map.ts';
import { describeTool } from './claude-tools.ts';
import { findSessionFile, listClaudeResumable, loadClaudeTranscript } from './claude-history.ts';
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
  toQuestion,
  type Rec,
} from './shared/common.ts';
import { childEnv, runQuick, spawnAgent, type SpawnedAgent } from './shared/proc.ts';

const DEFAULT_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
/** Env vars that make a nested `claude` think it runs inside another Claude Code / SDK host. */
const DROP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'NODE_OPTIONS'];

export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PHONECODE_CLAUDE_BIN || 'claude';
}

let discoveredModels: string[] | undefined;

interface PendingPermission {
  requestId: string;
  kind: 'tool' | 'plan' | 'question';
  toolName: string;
  toolUseId?: string;
  input: Rec;
  suggestions: unknown[];
  item: PermissionItem | QuestionItem;
}

type ControlWaiter = { resolve: (v: Rec) => void; reject: (e: Error) => void };

class ClaudeSession implements AgentSession {
  private proc: SpawnedAgent | undefined;
  private readonly events: AgentEvents;
  private readonly status: StatusTracker;
  private mapper: ClaudeMapper;
  private readonly pending = new Map<string, PendingPermission>();
  /** request_id -> our item id */
  private readonly byRequest = new Map<string, string>();
  private readonly control = new Map<string, ControlWaiter>();
  private sessionId: string | undefined;
  private model: string | undefined;
  private mode: PermissionMode;
  private turnsQueued = 0;
  private interruptRequested = false;
  private disposed = false;
  private lastCostTotal = 0;
  private turnStartedAt = 0;
  private noticeSeq = 0;
  private lastRateLimit = '';
  /** Whether the CLI has a session file we can --resume (false until the first turn of a new session). */
  private persisted: boolean;

  constructor(
    private readonly opts: AgentStartOptions,
    events: AgentEvents,
  ) {
    this.events = safeEvents(events);
    this.status = new StatusTracker(this.events);
    this.mapper = this.newMapper();
    this.model = opts.model;
    this.mode = opts.permissionMode ?? 'default';
    this.sessionId = opts.resumeId;
    this.persisted = opts.resumeId !== undefined;
  }

  private newMapper(): ClaudeMapper {
    const m = new ClaudeMapper(this.events, this.opts.cwd, true);
    m.onToolRefined = (toolId) => this.followToolDetail(toolId);
    return m;
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    if (this.opts.resumeId) {
      try {
        const file = await findSessionFile(this.opts.resumeId, this.opts.cwd, this.opts.env ?? process.env);
        if (file) {
          const items = await loadClaudeTranscript(file, this.opts.cwd);
          for (const item of items) {
            if (item.kind === 'tool') {
              this.mapper.tools.set(item.id, item);
              this.mapper.rawNames.set(item.id, item.name);
            }
            this.events.upsert(item);
          }
        } else {
          this.notice(
            'warn',
            `Could not find the transcript of session ${this.opts.resumeId}; resuming without history.`,
          );
        }
      } catch (e) {
        this.notice('warn', `Could not load the past transcript: ${errorMessage(e)}`);
      }
    }
    this.launch(this.opts.resumeId);
    this.status.emit();
  }

  private launch(resumeId: string | undefined): void {
    const args = [
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
    ];
    if (this.model) args.push('--model', this.model);
    if (this.mode !== 'default') args.push('--permission-mode', this.mode);
    if (resumeId && this.persisted) args.push('--resume', resumeId);
    else {
      // Fix the session id up front so it can be persisted before the first turn.
      this.sessionId ??= randomUUID();
      args.push('--session-id', this.sessionId);
    }
    const bin = claudeBin(this.opts.env ?? process.env);
    const proc = spawnAgent(bin, args, {
      cwd: this.opts.cwd,
      // Like the Agent SDK: mark ourselves as an SDK host.
      env: { ...childEnv(this.opts.env, DROP_ENV), CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      onLine: (v) => this.onLine(v),
      onInputLost: () => this.onInputLost(proc),
    });
    this.proc = proc;
    this.status.crashed = false;
    this.lastCostTotal = 0; // total_cost_usd restarts with every process
    if (this.sessionId) this.events.nativeSessionId(this.sessionId);
    void proc.exited.then((info) => this.onExit(proc, info));
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const init = this.request({ subtype: 'initialize' });
    // In print mode the CLI leaves the thinking display to the API, whose default for current
    // models is "omitted": thinking blocks arrive empty. Ask for summaries, as the TUI shows them.
    // Older CLIs answer with an error; thinking then stays empty, as before.
    this.request({ subtype: 'set_max_thinking_tokens', thinking_display: 'summarized' }).catch(() => {});
    try {
      const res = await init;
      const models = arr(res.models)
        .map((m) => str(rec(m).value))
        .filter((m): m is string => !!m);
      if (models.length) discoveredModels = models;
    } catch {
      // the exit handler reports a dead process
    }
  }

  private onExit(
    proc: SpawnedAgent,
    info: { code: number | null; signal: NodeJS.Signals | null; error?: Error },
  ): void {
    const tail = oneLine(proc.stderrTail().trim().split('\n').slice(-3).join(' '), 300);
    let text: string;
    if (info.error && /ENOENT/.test(info.error.message)) {
      text = `Claude Code CLI not found (${claudeBin(this.opts.env ?? process.env)}). Install it with \`npm i -g @anthropic-ai/claude-code\` or set PHONECODE_CLAUDE_BIN.`;
    } else {
      text = `Claude Code exited unexpectedly (${info.signal ?? `code ${info.code ?? '?'}`})${tail ? `: ${tail}` : ''}`;
    }
    this.lost(proc, text);
  }

  /** The process runs but takes no more input: drop it like a crash, so the next message starts a new one. */
  private onInputLost(proc: SpawnedAgent): void {
    if (this.proc !== proc || this.disposed) return;
    this.lost(proc, 'Claude Code stopped reading its input, so phone-code stopped it. Send your message again to restart it.');
    void proc.kill();
  }

  /** The process is gone (or unusable): end the turn as an error and wait for the next message. */
  private lost(proc: SpawnedAgent, text: string): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    for (const w of this.control.values()) w.reject(new Error('Claude Code exited'));
    this.control.clear();
    this.cancelAllPending();
    if (this.disposed) return;
    const wasActive = this.turnsQueued > 0;
    this.mapper.endTurn('error');
    this.turnsQueued = 0;
    this.status.turnActive = false;
    this.notice('error', text);
    if (wasActive) {
      this.events.upsert({
        kind: 'turn',
        id: `turn:${randomUUID()}`,
        ts: Date.now(),
        outcome: 'error',
        // The notice above already carries the details.
        durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
      });
    }
    this.status.crashed = true;
    this.status.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllPending();
    this.mapper.closeStreams();
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await proc.kill();
    this.status.turnActive = false;
    this.status.crashed = false;
    this.status.exited = true;
    this.status.emit();
  }

  // --------------------------------------------------------------- wire

  private write(msg: unknown): boolean {
    return this.proc?.writeJson(msg) ?? false;
  }

  private request(request: Rec, timeoutMs = 30_000): Promise<Rec> {
    const requestId = randomUUID();
    return new Promise<Rec>((resolve, reject) => {
      if (!this.proc) {
        reject(new Error('Claude Code is not running'));
        return;
      }
      // A failed write is reported through onInputLost / onExit, which reject every waiter.
      this.write({ type: 'control_request', request_id: requestId, request });
      const timer = setTimeout(() => {
        this.control.delete(requestId);
        reject(new Error(`${str(request.subtype) ?? 'control'} request timed out`));
      }, timeoutMs);
      this.control.set(requestId, {
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

  private respond(requestId: string, response: Rec): void {
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  private onLine(value: unknown): void {
    if (!isRec(value)) return;
    try {
      this.dispatch(value);
    } catch (e) {
      console.error('[claude] failed to handle message:', e);
    }
  }

  private dispatch(msg: Rec): void {
    switch (msg.type) {
      case 'control_response': {
        const r = rec(msg.response);
        const id = str(r.request_id);
        const w = id ? this.control.get(id) : undefined;
        if (!w || !id) return;
        this.control.delete(id);
        if (r.subtype === 'error') w.reject(new Error(str(r.error) ?? 'control request failed'));
        else w.resolve(rec(r.response));
        return;
      }
      case 'control_request':
        this.onControlRequest(msg);
        return;
      case 'control_cancel_request': {
        const id = str(msg.request_id);
        const itemId = id ? this.byRequest.get(id) : undefined;
        if (itemId) this.settle(itemId, 'cancelled');
        return;
      }
      case 'stream_event':
        this.markBusy();
        this.mapper.onStreamEvent(msg.event, str(msg.parent_tool_use_id) ?? null);
        return;
      case 'assistant':
        this.markBusy();
        this.mapper.onAssistant(msg);
        if (str(msg.error)) this.onAssistantError(msg);
        return;
      case 'user':
        // The core already shows the prompt; only tool results matter live.
        this.mapper.onToolResults(msg);
        return;
      case 'result':
        this.onResult(msg);
        return;
      case 'system':
        this.onSystem(msg);
        return;
      case 'rate_limit_event':
        this.onRateLimit(rec(msg.rate_limit_info));
        return;
      default:
        return; // keep_alive, active_goal, autocompact_state, tool_progress, … and future types
    }
  }

  private onSystem(msg: Rec): void {
    switch (msg.subtype) {
      case 'init': {
        const sid = str(msg.session_id);
        if (sid && sid !== this.sessionId) {
          this.sessionId = sid;
          this.events.nativeSessionId(sid);
        } else if (sid) this.sessionId = sid;
        const model = str(msg.model);
        const mode = asMode(msg.permissionMode);
        if (model) this.model = model;
        if (mode) this.mode = mode;
        this.events.meta({ ...(model ? { model } : {}), ...(mode ? { permissionMode: mode } : {}) });
        return;
      }
      case 'status': {
        const mode = asMode(msg.permissionMode);
        if (mode && mode !== this.mode) {
          this.mode = mode;
          this.events.meta({ permissionMode: mode });
        }
        if (msg.status === 'compacting') this.notice('info', 'Compacting conversation…', 'compact');
        if (msg.compact_result === 'failed')
          this.notice('warn', `Compaction failed: ${str(msg.compact_error) ?? ''}`, 'compact');
        return;
      }
      case 'compact_boundary': {
        const meta = rec(msg.compact_metadata);
        const pre = num(meta.pre_tokens);
        this.notice(
          'info',
          `Conversation compacted${meta.trigger === 'auto' ? ' automatically' : ''}${pre ? ` (${Math.round(pre / 1000)}k tokens before)` : ''}`,
          'compact',
        );
        return;
      }
      case 'api_retry': {
        const status = num(msg.error_status);
        this.notice(
          'warn',
          `API error${status ? ` ${status}` : ''}${str(msg.error) ? ` (${str(msg.error)})` : ''}, retrying (${num(msg.attempt) ?? '?'}/${num(msg.max_retries) ?? '?'})…`,
          'retry',
        );
        return;
      }
      case 'session_state_changed':
        // Authoritative "nothing is running" signal (when the CLI emits it).
        if (msg.state === 'running') this.markBusy();
        else if (msg.state === 'idle' && this.turnsQueued > 0 && this.pending.size === 0) {
          this.turnsQueued = 0;
          this.mapper.endTurn('completed');
          this.status.turnActive = false;
          this.status.emit();
        }
        return;
      case 'notification': {
        const text = str(msg.text) ?? str(msg.message);
        if (text) this.notice('info', text);
        return;
      }
      default:
        return;
    }
  }

  /** The CLI is working although we did not start a turn (e.g. a coalesced queue drained late). */
  private markBusy(): void {
    if (this.turnsQueued > 0 || this.disposed) return;
    this.turnsQueued = 1;
    this.turnStartedAt = Date.now();
    this.mapper.beginTurn();
    this.status.turnActive = true;
    this.status.emit();
  }

  private onAssistantError(msg: Rec): void {
    const kind = str(msg.error) ?? 'unknown';
    const hints: Record<string, string> = {
      authentication_failed: 'Claude Code is not signed in. Run `claude` on the host and log in.',
      billing_error: 'Billing problem with the Claude account.',
      rate_limit: 'Rate limited by the API.',
      overloaded: 'The API is overloaded.',
    };
    this.notice('error', hints[kind] ?? `API error: ${kind}`);
  }

  private onRateLimit(info: Rec): void {
    const status = str(info.status);
    if (!status || status === 'allowed') return;
    const key = `${status}:${num(info.resetsAt) ?? ''}`;
    if (key === this.lastRateLimit) return;
    this.lastRateLimit = key;
    const resets = num(info.resetsAt);
    const when = resets ? ` Resets at ${new Date(resets * 1000).toLocaleString()}.` : '';
    if (status === 'rejected') this.notice('error', `Usage limit reached.${when}`, 'ratelimit');
    else
      this.notice(
        'warn',
        `Approaching the usage limit (${Math.round((num(info.utilization) ?? 0) * 100)}%).${when}`,
        'ratelimit',
      );
  }

  private onResult(msg: Rec): void {
    const subtype = str(msg.subtype) ?? 'success';
    const isError = msg.is_error === true || subtype !== 'success';
    const outcome: TurnItem['outcome'] = this.interruptRequested
      ? 'interrupted'
      : isError
        ? 'error'
        : 'completed';
    this.mapper.endTurn(outcome);
    this.cancelAllPending();
    const usage = rec(msg.usage);
    const input =
      (num(usage.input_tokens) ?? 0) +
      (num(usage.cache_read_input_tokens) ?? 0) +
      (num(usage.cache_creation_input_tokens) ?? 0);
    // total_cost_usd is cumulative for the process: report this turn's share.
    const total = num(msg.total_cost_usd);
    let cost: number | undefined;
    if (total !== undefined) {
      cost = Math.round((total >= this.lastCostTotal ? total - this.lastCostTotal : total) * 1e6) / 1e6;
      this.lastCostTotal = total;
    }
    const errors = arr(msg.errors).map((e) => String(e));
    const error =
      outcome === 'error'
        ? errors.join('\n') ||
          (subtype === 'success' ? str(msg.result) : subtype.replace(/_/g, ' ')) ||
          'Turn failed'
        : undefined;
    const turn: TurnItem = {
      kind: 'turn',
      id: `turn:${str(msg.uuid) ?? randomUUID()}`,
      ts: Date.now(),
      outcome,
      ...(num(msg.duration_ms) !== undefined ? { durationMs: num(msg.duration_ms) } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(input ? { inputTokens: input } : {}),
      ...(num(usage.output_tokens) !== undefined ? { outputTokens: num(usage.output_tokens) } : {}),
      ...(error ? { error } : {}),
    };
    this.events.upsert(turn);
    this.persisted = true;
    // Queued prompts can be coalesced into one turn; the result lists them.
    const answered = Math.max(1, arr(msg.user_message_uuids).length);
    this.turnsQueued = Math.max(0, this.turnsQueued - answered);
    this.interruptRequested = false;
    this.status.turnActive = this.turnsQueued > 0;
    if (this.status.turnActive) this.mapper.beginTurn();
    this.status.emit();
  }

  // ---------------------------------------------------------- permissions

  private onControlRequest(msg: Rec): void {
    const requestId = str(msg.request_id);
    const req = rec(msg.request);
    if (!requestId) return;
    if (req.subtype !== 'can_use_tool') {
      // hook_callback / mcp_message / elicitation: we register none of those.
      this.write({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: `Unsupported request: ${str(req.subtype) ?? '?'}`,
        },
      });
      return;
    }
    const toolName = str(req.tool_name) ?? 'tool';
    const input = rec(req.input);
    const toolUseId = str(req.tool_use_id);
    const suggestions = arr(req.permission_suggestions);
    const ts = Date.now();
    let entry: PendingPermission;
    if (toolName === 'AskUserQuestion') {
      const item: QuestionItem = {
        kind: 'question',
        id: `q:${toolUseId ?? requestId}`,
        ts,
        status: 'pending',
        questions: arr(input.questions)
          .filter(isRec)
          .map((q) => toQuestion(q, q.multiSelect === true)),
      };
      entry = {
        requestId,
        kind: 'question',
        toolName,
        input,
        suggestions,
        item,
        ...(toolUseId ? { toolUseId } : {}),
      };
    } else if (toolName === 'ExitPlanMode') {
      const item: PermissionItem = {
        kind: 'permission',
        id: `perm:${toolUseId ?? requestId}`,
        ts,
        toolName: 'ExitPlanMode',
        title: 'Ready to code? Approve the plan to leave plan mode',
        input,
        status: 'pending',
        canAllowAlways: true,
      };
      entry = {
        requestId,
        kind: 'plan',
        toolName,
        input,
        suggestions,
        item,
        ...(toolUseId ? { toolUseId } : {}),
      };
    } else {
      const tool = toolUseId ? this.mapper.tools.get(toolUseId) : undefined;
      const view = describeTool(toolName, input, this.opts.cwd);
      const title = str(req.title) ?? `${view.name === toolName ? toolName : view.name}: ${view.title}`;
      const detail = tool?.detail ?? view.detail;
      const item: PermissionItem = {
        kind: 'permission',
        id: `perm:${toolUseId ?? requestId}`,
        ts,
        toolName: view.name,
        title,
        input,
        ...(detail ? { detail } : {}),
        status: 'pending',
        canAllowAlways: suggestions.length > 0,
      };
      entry = {
        requestId,
        kind: 'tool',
        toolName,
        input,
        suggestions,
        item,
        ...(toolUseId ? { toolUseId } : {}),
      };
    }
    this.pending.set(entry.item.id, entry);
    this.byRequest.set(requestId, entry.item.id);
    this.status.pending.add(entry.item.id);
    this.events.upsert(entry.item);
    this.status.emit();
  }

  /** A tool's diff got line numbers after the permission card was shown: update the card. */
  private followToolDetail(toolId: string): void {
    for (const p of this.pending.values()) {
      if (p.toolUseId === toolId && p.item.kind === 'permission' && p.item.status === 'pending') {
        const detail = this.mapper.tools.get(toolId)?.detail;
        if (detail) {
          p.item = { ...p.item, detail };
          this.events.upsert(p.item);
        }
      }
    }
  }

  private settle(
    itemId: string,
    status: 'allowed' | 'denied' | 'cancelled' | 'answered',
    answers?: Record<string, string>,
  ): PendingPermission | undefined {
    const p = this.pending.get(itemId);
    if (!p) return undefined;
    this.pending.delete(itemId);
    this.byRequest.delete(p.requestId);
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

  /** Cancel pending prompts and tell the CLI, which (outside a turn we interrupt) still waits for an answer. */
  private denyAllPending(): void {
    for (const p of [...this.pending.values()]) {
      this.settle(p.item.id, 'cancelled');
      if (p.toolUseId) this.mapper.denied.add(p.toolUseId);
      this.respond(p.requestId, {
        behavior: 'deny',
        message: 'The user cancelled this request.',
        interrupt: true,
        ...(p.toolUseId ? { toolUseID: p.toolUseId } : {}),
      });
    }
  }

  resolvePermission(itemId: string, decision: PermissionDecision, message?: string): void {
    const p = this.pending.get(itemId);
    if (!p || p.kind === 'question') return;
    const allow = decision !== 'deny';
    this.settle(itemId, allow ? 'allowed' : 'denied');
    if (!allow) {
      if (p.toolUseId) this.mapper.denied.add(p.toolUseId);
      this.respond(p.requestId, {
        behavior: 'deny',
        message:
          message ||
          (p.kind === 'plan'
            ? 'The user wants to keep planning. Do not start implementing yet.'
            : 'The user denied this action.'),
        ...(p.toolUseId ? { toolUseID: p.toolUseId } : {}),
      });
      return;
    }
    let updatedPermissions: unknown[] | undefined;
    if (p.kind === 'plan') {
      // TUI: "Yes, and auto-accept edits" vs "Yes, and manually approve edits".
      const mode: PermissionMode = decision === 'allowAlways' ? 'acceptEdits' : 'default';
      updatedPermissions = [{ type: 'setMode', mode, destination: 'session' }];
      this.mode = mode;
      this.events.meta({ permissionMode: mode });
    } else if (decision === 'allowAlways') {
      // Apply the CLI's own suggestions (rules / directories). A bare mode switch is
      // only applied when it is the sole suggestion (Edit-style prompts).
      const rules = p.suggestions.filter((s) => rec(s).type !== 'setMode');
      updatedPermissions = rules.length ? rules : p.suggestions;
      for (const s of updatedPermissions) {
        const mode = asMode(rec(s).mode);
        if (rec(s).type === 'setMode' && mode) {
          this.mode = mode;
          this.events.meta({ permissionMode: mode });
        }
      }
    }
    this.respond(p.requestId, {
      behavior: 'allow',
      updatedInput: p.input,
      ...(updatedPermissions?.length ? { updatedPermissions } : {}),
      ...(p.toolUseId ? { toolUseID: p.toolUseId } : {}),
    });
  }

  answerQuestion(itemId: string, answers: Record<string, string>): void {
    const p = this.pending.get(itemId);
    if (!p || p.kind !== 'question') return;
    this.settle(itemId, 'answered', answers);
    this.respond(p.requestId, {
      behavior: 'allow',
      updatedInput: { ...p.input, answers },
      ...(p.toolUseId ? { toolUseID: p.toolUseId } : {}),
    });
  }

  // ------------------------------------------------------------- actions

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    if (this.disposed) throw new Error('Session is closed');
    if (!this.proc) {
      // Crashed earlier: come back on the same conversation.
      this.mapper.closeStreams();
      this.launch(this.sessionId);
    }
    const content = buildContent(text, attachments);
    if (this.turnsQueued === 0) {
      this.turnStartedAt = Date.now();
      this.mapper.beginTurn();
    }
    this.turnsQueued++;
    this.status.turnActive = true;
    // The core marked the session running already; re-report in case the status did not change.
    this.status.emit(true);
    // If the message cannot be written, onInputLost (or onExit) ends this turn as an error.
    this.write({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
      uuid: randomUUID(),
    });
  }

  async interrupt(): Promise<void> {
    if (!this.proc || this.turnsQueued === 0) {
      // No turn of ours is running, but the CLI may still ask (e.g. after a turn ended):
      // the stop button must clear those prompts too. Deny them so the CLI does not wait.
      this.denyAllPending();
      return;
    }
    this.interruptRequested = true;
    this.cancelAllPending();
    try {
      await this.request({ subtype: 'interrupt' }, 10_000);
    } catch (e) {
      this.notice('warn', `Interrupt failed: ${errorMessage(e)}`);
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    if (!this.proc) {
      this.events.meta({ permissionMode: mode });
      return;
    }
    try {
      const res = await this.request({ subtype: 'set_permission_mode', mode });
      this.events.meta({ permissionMode: asMode(res.mode) ?? mode });
    } catch (e) {
      this.notice('warn', `Could not switch to ${mode}: ${errorMessage(e)}`);
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    if (!this.proc) {
      this.events.meta({ model });
      return;
    }
    try {
      const res = await this.request({ subtype: 'set_model', model });
      this.events.meta({ model: str(res.model) ?? model });
    } catch (e) {
      this.notice('warn', `Could not switch model to ${model}: ${errorMessage(e)}`);
    }
  }

  private notice(level: NoticeItem['level'], text: string, key?: string): void {
    const id = key
      ? `notice:${key}:${this.turnsQueued > 0 ? this.turnStartedAt : 'idle'}`
      : `notice:${++this.noticeSeq}:${Date.now()}`;
    this.events.upsert({ kind: 'notice', id, ts: Date.now(), level, text });
  }
}

function asMode(v: unknown): PermissionMode | undefined {
  return v === 'default' || v === 'acceptEdits' || v === 'plan' || v === 'bypassPermissions' ? v : undefined;
}

function buildContent(text: string, attachments: Attachment[] | undefined): string | Rec[] {
  if (!attachments?.length) return text;
  const blocks: Rec[] = [];
  for (const a of attachments) {
    if (a.mediaType.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    } else if (a.mediaType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    } else {
      const body = Buffer.from(a.data, 'base64').toString('utf8');
      blocks.push({
        type: 'text',
        text: `<attachment name="${a.name ?? 'file'}" type="${a.mediaType}">\n${body}\n</attachment>`,
      });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

export function createClaudeAdapter(): AgentAdapter {
  return {
    kind: 'claude',
    async detect() {
      const bin = claudeBin();
      const out = await runQuick(bin, ['--version']);
      if (out === undefined) return { available: false };
      const version = /\d+\.\d+\.\d+/.exec(out)?.[0] ?? out.split(/\s/)[0];
      return { available: true, ...(version ? { version } : {}), models: discoveredModels ?? DEFAULT_MODELS };
    },
    async start(opts, events) {
      const session = new ClaudeSession(opts, events);
      await session.init();
      return session;
    },
    async listResumable(limit?: number): Promise<ResumableSession[]> {
      return listClaudeResumable(limit ?? 50);
    },
  };
}
