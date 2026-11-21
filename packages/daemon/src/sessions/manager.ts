import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentKind, CreateSessionParams, ResumableSession, SessionInfo } from '@phone-code/protocol';
import type { AdapterRegistry } from '../agents/types.ts';
import type { StatePaths } from '../config.ts';
import { assertDirectory, expandPath } from '../fs-list.ts';
import { userShell } from '../host-info.ts';
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

  private constructor(
    private readonly paths: StatePaths,
    private readonly adapters: AdapterRegistry,
    private readonly events: ManagerEvents,
  ) {
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
    return { host: this, adapters: this.adapters, transcriptsDir: this.paths.transcripts };
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

  async create(params: CreateSessionParams): Promise<SessionInfo> {
    const cwd = expandPath(params.cwd);
    await assertDirectory(cwd);
    const id = randomId(9);
    let session: AnySession;
    if (params.kind === 'agent') {
      const agent: AgentKind = params.agent ?? 'claude';
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

  async delete(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (s === undefined) return false;
    this.sessions.delete(id);
    this.changed('structure');
    await s.dispose();
    await s.removeFiles();
    return true;
  }

  async history(agent: AgentKind | undefined): Promise<ResumableSession[]> {
    const kinds: AgentKind[] = agent === undefined ? ['claude', 'codex'] : [agent];
    const lists = await Promise.all(
      kinds.map((k) =>
        this.adapters[k].listResumable(50).catch((err: unknown) => {
          log.warn(`listResumable failed for ${k}`, err);
          return [];
        }),
      ),
    );
    return lists.flat().toSorted((a, b) => b.updatedAt - a.updatedAt);
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
