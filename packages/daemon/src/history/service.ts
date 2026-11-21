/**
 * "All chats" (`history.list` with a `query`): one newest-first list of every
 * conversation the host knows, from every harness, merged with phone-code's
 * own sessions (archived ones included) and de-duplicated, so a conversation
 * that already is a phone-code session appears once, with `sessionId` set.
 *
 * Sources, all queried in parallel:
 *   - Claude Code and Codex: incremental on-disk indexes (index-file.ts) with
 *     title, folder and message text, so text search covers whole conversations.
 *   - ACP agents that can list sessions (session/list): each needs its own
 *     process, so each gets ACP_WAIT_MS; a slow one is left out of this answer
 *     (its result is cached for the next query) and never holds up the rest.
 *   - phone-code's own transcripts (also indexed), for sessions of any agent.
 *
 * Searching walks the in-memory index in chunks, yielding to the event loop
 * between them, so a large index never stalls the daemon.
 */
import os from 'node:os';
import path from 'node:path';
import type { AgentId, HistoryQuery, ResumableSession, SessionInfo } from '@phone-code/protocol';
import { agentDisplayName, listAdapters, type AdapterRegistry } from '../agents/types.ts';
import type { StatePaths } from '../config.ts';
import { log } from '../log.ts';
import { ConversationIndex } from './index-file.ts';
import {
  extractClaude,
  extractCodex,
  extractTranscript,
  listClaudeFiles,
  listCodexFiles,
  listTranscriptFiles,
} from './sources.ts';

const ACP_WAIT_MS = 2500;
const ACP_CACHE_MS = 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CHUNK = 250;
const SNIPPET = 140;

/** A phone-code session as the history needs it. */
export interface KnownSession {
  info: SessionInfo;
  /** The agent's own id for the conversation (what resumeId is for that agent). */
  nativeId?: string;
}

interface Candidate {
  entry: ResumableSession;
  /** Searchable message text (native and/or our transcript). */
  text: string;
  /** `text` lower-cased, cached by the index. */
  lower: () => string;
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function inside(cwd: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, '');
  return f === '' || cwd === f || cwd.startsWith(`${f}/`);
}

function snippetAt(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + len + SNIPPET - 50);
  const body = text.slice(start, end).replaceAll(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

export class HistoryService {
  private readonly claude: ConversationIndex;
  private readonly codex: ConversationIndex;
  private readonly transcripts: ConversationIndex;
  private readonly acp = new Map<
    string,
    { at: number; list: ResumableSession[]; inflight?: Promise<void> }
  >();

  constructor(
    paths: StatePaths,
    private readonly adapters: AdapterRegistry,
  ) {
    this.claude = new ConversationIndex(paths.index, 'claude', () => listClaudeFiles(), extractClaude);
    this.codex = new ConversationIndex(paths.index, 'codex', () => listCodexFiles(), extractCodex);
    this.transcripts = new ConversationIndex(
      paths.index,
      'phonecode',
      () => listTranscriptFiles(paths.transcripts),
      extractTranscript,
    );
  }

  /** Build the indexes in the background so the first search is fast. */
  warm(): void {
    void Promise.all([this.claude.refresh(), this.codex.refresh(), this.transcripts.refresh()]).catch(
      (err: unknown) => log.warn('history index warm-up failed', err),
    );
  }

  /** Index refresh timings (for logs and the benchmark). */
  stats(): Record<string, unknown> {
    return {
      claude: this.claude.lastRefresh,
      codex: this.codex.lastRefresh,
      phonecode: this.transcripts.lastRefresh,
    };
  }

  private async native(index: ConversationIndex, agent: AgentId): Promise<Candidate[]> {
    await index.refresh();
    return index.conversations().map((c) => ({
      entry: {
        agent,
        resumeId: c.resumeId,
        cwd: c.cwd,
        title: c.title,
        updatedAt: Math.max(c.updatedAt ?? 0, c.mtime),
        ...(c.messageCount === undefined ? {} : { messageCount: c.messageCount }),
      },
      text: c.text,
      lower: () => index.lowerText(c.path),
    }));
  }

  /** Sessions of an ACP agent, from cache or a fresh `session/list` (bounded wait). */
  private async acpList(id: string): Promise<Candidate[]> {
    const adapter = this.adapters[id];
    if (adapter === undefined) return [];
    let slot = this.acp.get(id);
    if (slot === undefined) {
      slot = { at: 0, list: [] };
      this.acp.set(id, slot);
    }
    const s = slot;
    if (Date.now() - s.at > ACP_CACHE_MS && s.inflight === undefined) {
      s.inflight = adapter
        .listResumable(MAX_LIMIT)
        .then(
          (list) => {
            s.list = list;
            s.at = Date.now();
            return undefined;
          },
          (err: unknown) => log.debug(`listing ${id} sessions failed`, err),
        )
        .finally(() => {
          s.inflight = undefined;
        });
    }
    if (s.inflight !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([s.inflight, new Promise((r) => (timer = setTimeout(r, ACP_WAIT_MS)))]);
      clearTimeout(timer);
    }
    return s.list.map((entry) => ({ entry, text: '', lower: () => '' }));
  }

  async query(
    agent: AgentId | undefined,
    q: HistoryQuery,
    sessions: KnownSession[],
  ): Promise<ResumableSession[]> {
    const want = (id: AgentId): boolean => agent === undefined || agent === id;
    const acpIds = listAdapters(this.adapters)
      .filter((a) => a.impl === 'acp' && want(a.kind))
      .map((a) => a.kind);
    const lists = await Promise.all([
      want('claude') ? this.native(this.claude, 'claude') : Promise.resolve([]),
      want('codex') ? this.native(this.codex, 'codex') : Promise.resolve([]),
      ...acpIds.map((id) => this.acpList(id)),
      this.transcripts.refresh().then(() => undefined),
    ]);
    const pcText = new Map<string, { text: string; path: string }>();
    for (const c of this.transcripts.conversations()) pcText.set(c.resumeId, { text: c.text, path: c.path });

    const byKey = new Map<string, Candidate>();
    for (const list of lists) {
      for (const c of list ?? []) {
        const key = `${c.entry.agent}\u0000${c.entry.resumeId}`;
        const prev = byKey.get(key);
        if (prev === undefined || prev.entry.updatedAt < c.entry.updatedAt) byKey.set(key, c);
      }
    }
    // Overlay phone-code's own sessions: the same conversation appears once.
    for (const s of sessions) {
      const a = s.info.agent;
      if (s.info.kind !== 'agent' || a === undefined || !want(a)) continue;
      const resumeId = s.nativeId ?? s.info.id;
      const key = `${a}\u0000${resumeId}`;
      const found = byKey.get(key);
      const own = pcText.get(s.info.id);
      const ownLower = (): string => (own === undefined ? '' : this.transcripts.lowerText(own.path));
      const entry: ResumableSession = {
        ...found?.entry,
        agent: a,
        resumeId,
        cwd: s.info.cwd,
        title: s.info.title,
        updatedAt: Math.max(found?.entry.updatedAt ?? 0, s.info.updatedAt),
        sessionId: s.info.id,
        ...(s.info.archived === true ? { archived: true } : {}),
      };
      const text = `${found?.text ?? ''}\n${own?.text ?? ''}`;
      const lower = found === undefined ? ownLower : (): string => `${found.lower()}\n${ownLower()}`;
      byKey.set(key, { entry, text, lower });
    }

    const folder = q.cwd === undefined ? undefined : expandHome(q.cwd);
    const terms = (q.text ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== '');
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const sorted = [...byKey.values()].toSorted((x, y) => y.entry.updatedAt - x.entry.updatedAt);
    const out: ResumableSession[] = [];
    for (let i = 0; i < sorted.length && out.length < limit; i++) {
      // oxlint-disable-next-line no-await-in-loop -- yielding to the event loop is the point
      if (i > 0 && i % CHUNK === 0) await yieldNow();
      const c = sorted[i];
      if (c === undefined) continue;
      const e = c.entry;
      if (q.before !== undefined && e.updatedAt >= q.before) continue;
      if (folder !== undefined && !inside(e.cwd, folder)) continue;
      let snippet: string | undefined;
      if (terms.length > 0) {
        const head = `${e.title}\n${e.cwd}`.toLowerCase();
        const body = c.lower();
        let ok = true;
        for (const t of terms) {
          if (head.includes(t)) continue;
          const at = body.indexOf(t);
          if (at < 0) {
            ok = false;
            break;
          }
          snippet ??= snippetAt(c.text, at, t.length);
        }
        if (!ok) continue;
      }
      out.push({
        ...e,
        agentName: agentDisplayName(this.adapters, e.agent),
        ...(snippet === undefined ? {} : { snippet }),
      });
    }
    return out;
  }
}
