/** Small helpers shared by the agent adapters. Everything here is defensive: agent output is untrusted JSON. */
import path from 'node:path';
import os from 'node:os';
import type { ChatItem, EffortOption, QuestionItem, SessionStatus } from '@phone-code/protocol';
import type { AgentEvents } from '../types.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function rec(v: unknown): Rec {
  return isRec(v) ? v : {};
}

/** Max characters of tool output kept on a ToolItem. */
export const OUTPUT_LIMIT = 24_000;

/** Keep the head and the tail of long output (the tail is usually where errors are). */
export function truncateOutput(text: string, limit = OUTPUT_LIMIT): { output: string; truncated: boolean } {
  if (text.length <= limit) return { output: text, truncated: false };
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return {
    output: `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** One line, at most `max` characters. */
export function oneLine(text: string, max = 80): string {
  const first = text.trim().split('\n')[0] ?? '';
  const multi = text.trim().includes('\n');
  const s = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return multi && s.length < max ? `${s} …` : s;
}

/** Path relative to cwd when inside it, `~`-shortened otherwise. */
export function displayPath(p: string, cwd: string): string {
  if (!p) return p;
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  if (rel === '') return '.';
  const home = os.homedir();
  if (abs === home || abs.startsWith(home + path.sep)) return `~${abs.slice(home.length)}`;
  return abs;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Derives SessionStatus from the adapter's state and only reports changes.
 * running while a turn is active, waiting while any permission/question is
 * pending (wins over running), idle otherwise, error after a crash.
 */
export class StatusTracker {
  private last: SessionStatus | undefined;
  turnActive = false;
  pending = new Set<string>();
  crashed = false;
  exited = false;

  constructor(private readonly events: AgentEvents) {}

  compute(): SessionStatus {
    if (this.crashed) return 'error';
    if (this.exited) return 'exited';
    if (this.pending.size > 0) return 'waiting';
    if (this.turnActive) return 'running';
    return 'idle';
  }

  /**
   * `force` re-reports an unchanged status: the core marks a session `running`
   * on its own when it hands over a message, so a send that fails at once must
   * say where the session really is.
   */
  emit(force = false): void {
    const s = this.compute();
    if (force || s !== this.last) {
      this.last = s;
      this.events.status(s);
    }
  }
}

function guard<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  return (...a: A): void => {
    try {
      fn(...a);
    } catch (e) {
      console.error('[agents] event consumer threw:', e);
    }
  };
}

/** Wraps AgentEvents so a buggy consumer can never break the adapter's read loop. */
export function safeEvents(events: AgentEvents): AgentEvents {
  return {
    upsert: guard((item: ChatItem) => events.upsert(item)),
    delta: guard((id: string, text: string) => events.delta(id, text)),
    status: guard((s: SessionStatus) => events.status(s)),
    nativeSessionId: guard((id: string) => events.nativeSessionId(id)),
    meta: guard((m: Parameters<AgentEvents['meta']>[0]) => events.meta(m)),
    image: (data, name) => {
      try {
        return events.image(data, name);
      } catch (e) {
        console.error('[agents] image consumer threw:', e);
        return undefined;
      }
    },
    imageFile: (p, name) => events.imageFile(p, name).catch(() => undefined),
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  const it = items.entries();
  const step = async (): Promise<void> => {
    const next = it.next();
    if (next.done) return;
    const [i, item] = next.value;
    out[i] = await fn(item);
    return step();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, step));
  return out;
}

export type Question = QuestionItem['questions'][number];

/** One question of a QuestionItem from a loosely typed agent payload. */
export function toQuestion(q: Rec, multiSelect: boolean): Question {
  const out: Question = {
    question: str(q.question) ?? '',
    multiSelect,
    options: arr(q.options)
      .filter(isRec)
      .map((o) => {
        const opt: Question['options'][number] = { label: str(o.label) ?? '' };
        const description = str(o.description);
        if (description) opt.description = description;
        return opt;
      }),
  };
  const header = str(q.header);
  if (header) out.header = header;
  return out;
}

const EFFORT_NAMES: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Thinking levels with display names ("xhigh" -> "Extra high"); unknown ids keep their own name. */
export function effortOptions(levels: Array<{ id: string; description?: string }>): EffortOption[] {
  const out: EffortOption[] = [];
  for (const { id, description } of levels) {
    if (id === '' || out.some((o) => o.id === id)) continue;
    const name = EFFORT_NAMES[id];
    out.push({ id, ...(name ? { name } : {}), ...(description ? { description } : {}) });
  }
  return out;
}

/** Text an agent can take in a message as it is: under this size, valid UTF-8, no NUL bytes. */
const INLINE_TEXT_MAX = 256 * 1024;

/**
 * A file the user attached that is not an image, as text for the agent's
 * message. A text file small enough goes in whole; anything else (a binary,
 * a spreadsheet, a big log) is named with the path it was saved at on this
 * computer, where the agent can open it with its own tools.
 */
export function attachmentText(a: { mediaType: string; name?: string; data: string; path?: string }): string {
  const name = a.name ?? 'file';
  const bytes = Buffer.from(a.data, 'base64');
  let body: string | undefined;
  if (bytes.length <= INLINE_TEXT_MAX && !bytes.includes(0)) {
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      body = undefined;
    }
  }
  const where = a.path ? ` path="${a.path}"` : '';
  if (body !== undefined)
    return `<attachment name="${name}" type="${a.mediaType}"${where}>\n${body}\n</attachment>`;
  return a.path
    ? `<attachment name="${name}" type="${a.mediaType}" path="${a.path}">\nThis file is saved at ${a.path} on this computer. Open it from there.\n</attachment>`
    : `<attachment name="${name}" type="${a.mediaType}">\n(${bytes.length} bytes, not text: it could not be passed on.)\n</attachment>`;
}
