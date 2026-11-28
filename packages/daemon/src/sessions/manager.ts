import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  DEFAULT_AGENT,
  type AgentId,
  type CreateSessionParams,
  type HistoryQuery,
  type ResumableSession,
  type SessionInfo,
  type SlashCommand,
} from '@phone-code/protocol';
import { agentDisplayName, listAdapters, type AdapterRegistry } from '../agents/types.ts';
import type { StatePaths } from '../config.ts';
import { assertDirectory, expandPath } from '../fs-list.ts';
import { HistoryService, type KnownSession } from '../history/service.ts';
import { userShell } from '../host-info.ts';
import { ImageStore } from '../images/store.ts';
import { log } from '../log.ts';
import { JsonWriter, randomId, readJson } from '../util/files.ts';
import { isRecord } from '../util/guards.ts';
import { ChatSession, type ChatDeps } from './chat.ts';
import { TerminalSession, type TerminalDeps } from './terminal.ts';
import type { ChangeKind, PersistedSession, SessionHost } from './types.ts';

const STRUCTURE_DEBOUNCE_MS = 30;
const ACTIVITY_DEBOUNCE_MS = 1000;
const LOGIN_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'ksh', 'dash', 'tcsh', 'csh']);

export type AnySession = ChatSession | TerminalSession;

export interface ManagerEvents {
  /** Session list changed (already debounced). */
  sessions(list: SessionInfo[]): void;
  attention(session: SessionInfo, reason: 'waiting' | 'turn'): void;
}

function isPersisted(v: unknown): v is PersistedSession {
  if (!isRecord(v) || !isRecord(v['info']) || typeof v['seq'] !== 'number') return false;
  const info = v['info'];
  return typeof info['id'] === 'string' && (info['kind'] === 'agent' || info['kind'] === 'terminal');
}

/** Environment for spawned shells: the daemon's own, minus its private knobs. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('PHONECODE_')) env[k] = v;
  }
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['TERM_PROGRAM'] = 'phone-code';
  env['LANG'] ??= 'en_US.UTF-8';
  return env;
}

export class SessionManager implements SessionHost {
  private readonly sessions = new Map<string, AnySession>();
  private readonly writer: JsonWriter;
  private structureTimer: ReturnType<typeof setTimeout> | undefined;
  private activityTimer: ReturnType<typeof setTimeout> | undefined;
  readonly images: ImageStore;
  readonly historyIndex: HistoryService;
  /** Slash commands per agent known without a session (AgentInfo.commands), set by the host info. */
  catalogCommands: (agent: AgentId) => Promise<SlashCommand[] | undefined> = () => Promise.resolve(undefined);

  private constructor(
    private readonly paths: StatePaths,
    private readonly adapters: AdapterRegistry,
    private readonly events: ManagerEvents,
  ) {
    this.images = new ImageStore(paths.images);
    this.historyIndex = new HistoryService(paths, adapters);
    this.writer = new JsonWriter(paths.sessions, () => ({
      v: 1,
      sessions: [...this.sessions.values()].map((s) => s.toRecord()),
    }));
  }

  static async load(
    paths: StatePaths,
    adapters: AdapterRegistry,
    events: ManagerEvents,
  ): Promise<SessionManager> {
    const m = new SessionManager(paths, adapters, events);
    const data = await readJson(paths.sessions);
    const list =
      typeof data === 'object' && data !== null && 'sessions' in data && Array.isArray(data.sessions)
        ? (data.sessions as unknown[])
        : [];
    for (const raw of list) {
      if (!isPersisted(raw)) continue;
      const s =
        raw.info.kind === 'agent'
          ? ChatSession.restore(raw, m.chatDeps())
          : TerminalSession.restore(raw, m.terminalDeps());
      m.sessions.set(raw.info.id, s);
    }
    // Record the restored (jumped) seqs before any client can see them. Otherwise a
    // crash before the next write restores the same seqs again, over a transcript
    // that changed in between, and `afterSeq` resumes replay onto a stale base.
    if (m.sessions.size > 0) await m.writer.flush();
    return m;
  }

  private chatDeps(): ChatDeps {
    return {
      host: this,
      adapters: this.adapters,
      transcriptsDir: this.paths.transcripts,
      images: this.images,
    };
  }

  private terminalDeps(): TerminalDeps {
    return { host: this, terminalsDir: this.paths.terminals };
  }

  // ----------------------------------------------------------- SessionHost

  changed(kind: ChangeKind): void {
    if (kind === 'structure') {
      this.writer.schedule();
      this.structureTimer ??= setTimeout(() => this.broadcast(), STRUCTURE_DEBOUNCE_MS);
    } else {
      this.activityTimer ??= setTimeout(() => {
        this.writer.schedule();
        this.broadcast();
      }, ACTIVITY_DEBOUNCE_MS);
    }
  }

  attention(session: SessionInfo, reason: 'waiting' | 'turn'): void {
    this.events.attention(session, reason);
  }

  private broadcast(): void {
    if (this.structureTimer !== undefined) clearTimeout(this.structureTimer);
    if (this.activityTimer !== undefined) clearTimeout(this.activityTimer);
    this.structureTimer = undefined;
    this.activityTimer = undefined;
    this.events.sessions(this.list());
  }

  // ------------------------------------------------------------------ API

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info).toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): AnySession | undefined {
    return this.sessions.get(id);
  }

  /** The phone-code session that already is this agent conversation, if any. */
  private findResumed(agent: AgentId, resumeId: string): ChatSession | undefined {
    for (const s of this.sessions.values()) {
      if (!(s instanceof ChatSession) || s.info.agent !== agent) continue;
      if (s.nativeId === resumeId || s.info.id === resumeId) return s;
    }
    return undefined;
  }

  async create(params: CreateSessionParams): Promise<SessionInfo> {
    if (params.kind === 'agent' && params.resumeId !== undefined) {
      // Continuing a chat that is already a phone-code session (in the sidebar or
      // archived) opens that session instead of making a duplicate.
      const existing = this.findResumed(params.agent ?? DEFAULT_AGENT, params.resumeId);
      if (existing !== undefined) {
        await existing.setArchived(false);
        return existing.info;
      }
    }
    const cwd = expandPath(params.cwd);
    await assertDirectory(cwd);
    const id = randomId(9);
    let session: AnySession;
    if (params.kind === 'agent') {
      const agent: AgentId = params.agent ?? DEFAULT_AGENT;
      if (this.adapters[agent] === undefined) throw new Error(`Unknown agent "${agent}"`);
      session = ChatSession.create(id, agent, cwd, params, this.chatDeps());
    } else {
      const shell = userShell();
      const loginArgs = LOGIN_SHELLS.has(basename(shell)) ? ['-l'] : [];
      const argv =
        params.command === undefined ? [shell, ...loginArgs] : [shell, ...loginArgs, '-c', params.command];
      const title = params.title?.trim();
      session = TerminalSession.create(
        id,
        { argv, cwd, env: childEnv(), cols: params.cols ?? 80, rows: params.rows ?? 24 },
        title === undefined || title === '' ? undefined : title,
        params.command,
        this.terminalDeps(),
      );
    }
    this.sessions.set(id, session);
    this.changed('structure');
    return session.info;
  }

  rename(id: string, title: string): SessionInfo | undefined {
    const s = this.sessions.get(id);
    if (s === undefined) return undefined;
    s.rename(title.trim().slice(0, 200));
    return s.info;
  }

  async archive(id: string, archived: boolean): Promise<SessionInfo | undefined> {
    const s = this.sessions.get(id);
    if (s === undefined) return undefined;
    await s.setArchived(archived);
    return s.info;
  }

  /** Slash commands of a session: what its running agent reported, else what the agent offers in general. */
  async commands(id: string): Promise<SlashCommand[] | undefined> {
    const s = this.sessions.get(id);
    if (s === undefined) return undefined;
    if (!(s instanceof ChatSession)) return [];
    return s.agentCommands ?? (await this.catalogCommands(s.info.agent ?? DEFAULT_AGENT)) ?? [];
  }

  async delete(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (s === undefined) return false;
    this.sessions.delete(id);
    this.changed('structure');
    await s.dispose();
    await s.removeFiles();
    return true;
  }

  private known(): KnownSession[] {
    return [...this.sessions.values()].map((s) =>
      s instanceof ChatSession && s.nativeId !== undefined
        ? { info: s.info, nativeId: s.nativeId }
        : { info: s.info },
    );
  }

  /**
   * With a `query` (even `{}`): "All chats" across every agent, merged with
   * phone-code's own sessions (history/service.ts). Without one, the older
   * resume picker: native agents only (or the one asked for), each entry that
   * already is a phone-code session marked with its `sessionId`.
   */
  async history(agent: AgentId | undefined, query?: HistoryQuery): Promise<ResumableSession[]> {
    if (query !== undefined) return this.historyIndex.query(agent, query, this.known());
    // Without an agent: the native ones only (listing an ACP agent's sessions starts its process).
    const kinds: AgentId[] =
      agent === undefined
        ? listAdapters(this.adapters)
            .filter((a) => (a.impl ?? 'native') === 'native' && a.external !== true)
            .map((a) => a.kind)
        : [agent];
    const lists = await Promise.all(
      kinds.map((k) =>
        (this.adapters[k]?.listResumable(50) ?? Promise.resolve([])).catch((err: unknown) => {
          log.warn(`listResumable failed for ${k}`, err);
          return [];
        }),
      ),
    );
    const mine = new Map<string, SessionInfo>();
    for (const k of this.known()) {
      if (k.nativeId !== undefined && k.info.agent !== undefined)
        mine.set(`${k.info.agent}\u0000${k.nativeId}`, k.info);
    }
    // Copies: adapters may share the listed objects with other callers.
    const out: ResumableSession[] = [];
    for (const listed of lists.flat()) {
      const e: ResumableSession = Object.assign({}, listed, {
        agentName: agentDisplayName(this.adapters, listed.agent),
      });
      const s = mine.get(`${e.agent}\u0000${e.resumeId}`);
      if (s !== undefined) {
        e.sessionId = s.id;
        if (s.archived === true) e.archived = true;
      }
      out.push(e);
    }
    return out.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.transcripts, { recursive: true, mode: 0o700 }),
      mkdir(this.paths.terminals, { recursive: true, mode: 0o700 }),
    ]);
  }

  /** Persist everything and stop all processes. */
  async shutdown(): Promise<void> {
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => s.persist().catch((err: unknown) => log.warn('persist failed', err))));
    await this.writer.flush();
    await Promise.all(all.map((s) => s.dispose().catch((err: unknown) => log.warn('dispose failed', err))));
  }
}
