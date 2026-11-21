/**
 * Incremental on-disk index of conversation files, for "All chats".
 *
 * One index per source (Claude Code projects, Codex rollouts, phone-code's
 * own transcripts), stored as JSON lines in `<state>/index/<name>.jsonl`.
 * Each file is keyed by path and remembered with its mtime and size: a
 * refresh only stats the files and re-reads the ones that changed, so after
 * the first build a query costs one stat per file. Reading runs in a small
 * pool of async workers (each file is streamed chunk by chunk), so the daemon
 * keeps answering while an index is built.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '../log.ts';
import { writeFileAtomic } from '../util/files.ts';
import { isRecord, parseJson } from '../util/guards.ts';
import { mapPool } from '../agents/shared/common.ts';

const VERSION = 1;
/** Files read at once while building. Low on purpose: indexing must not starve the daemon. */
const READ_POOL = 4;

/** What an extractor learns from one conversation file. */
export interface Conversation {
  resumeId: string;
  cwd: string;
  title: string;
  /** Last activity (defaults to the file's mtime). */
  updatedAt?: number;
  messageCount?: number;
  /** User and assistant text, capped (see TEXT_CAP), for search. */
  text: string;
}

export interface FileStat {
  path: string;
  size: number;
  mtime: number;
}

interface Row extends FileStat {
  /** Undefined: the file is not a resumable conversation (cached so it is not read again). */
  conv?: Conversation;
}

export type Extractor = (file: FileStat) => Promise<Conversation | undefined>;

/** Max characters of message text kept per conversation: the first part and the last part. */
export const TEXT_CAP = 48_000;
const TEXT_HEAD = 32_000;

/** Join text pieces, keeping the first TEXT_HEAD and the last characters up to TEXT_CAP. */
export function capText(pieces: string[]): string {
  const all = pieces.join('\n');
  if (all.length <= TEXT_CAP) return all;
  return `${all.slice(0, TEXT_HEAD)}\n…\n${all.slice(all.length - (TEXT_CAP - TEXT_HEAD))}`;
}

function isRow(v: unknown): v is Row {
  return (
    isRecord(v) &&
    typeof v['path'] === 'string' &&
    typeof v['size'] === 'number' &&
    typeof v['mtime'] === 'number' &&
    (v['conv'] === undefined || isRecord(v['conv']))
  );
}

export interface RefreshStats {
  files: number;
  read: number;
  ms: number;
}

export class ConversationIndex {
  private rows = new Map<string, Row>();
  /** Lower-cased text per path, made on first search and dropped when the file changes. */
  private readonly lc = new Map<string, string>();
  private loaded: Promise<void> | undefined;
  private running: Promise<RefreshStats> | undefined;
  private readonly file: string;
  lastRefresh: RefreshStats | undefined;

  constructor(
    dir: string,
    readonly name: string,
    private readonly list: () => Promise<FileStat[]>,
    private readonly extract: Extractor,
  ) {
    this.file = join(dir, `${name}.jsonl`);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const f = Bun.file(this.file);
      if (!(await f.exists())) return;
      const lines = (await f.text()).split('\n');
      const head = parseJson(lines[0] ?? '');
      if (!isRecord(head) || head['v'] !== VERSION) return;
      for (const line of lines.slice(1)) {
        const row = parseJson(line);
        if (isRow(row)) this.rows.set(row.path, row);
      }
    })().catch((err: unknown) => log.warn(`could not load the ${this.name} index`, err));
    return this.loaded;
  }

  /** Bring the index up to date with the files on disk (one refresh at a time). */
  refresh(): Promise<RefreshStats> {
    this.running ??= this.doRefresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doRefresh(): Promise<RefreshStats> {
    const started = performance.now();
    await this.load();
    const files = await this.list();
    const seen = new Set<string>();
    const stale: FileStat[] = [];
    for (const f of files) {
      seen.add(f.path);
      const row = this.rows.get(f.path);
      if (row?.size !== f.size || row.mtime !== f.mtime) stale.push(f);
    }
    let changed = stale.length > 0;
    for (const path of this.rows.keys()) {
      if (!seen.has(path)) {
        this.rows.delete(path);
        this.lc.delete(path);
        changed = true;
      }
    }
    // Newest first, so a query that waits sees recent conversations soonest.
    stale.sort((a, b) => b.mtime - a.mtime);
    await mapPool(stale, READ_POOL, async (f) => {
      let conv: Conversation | undefined;
      try {
        conv = await this.extract(f);
      } catch {
        conv = undefined;
      }
      this.rows.set(f.path, { ...f, ...(conv === undefined ? {} : { conv }) });
      this.lc.delete(f.path);
    });
    if (changed) await this.save();
    const stats = { files: files.length, read: stale.length, ms: Math.round(performance.now() - started) };
    this.lastRefresh = stats;
    if (stale.length > 0) log.debug(`${this.name} index: ${stale.length}/${files.length} files read in ${stats.ms} ms`);
    return stats;
  }

  private async save(): Promise<void> {
    const parts = [JSON.stringify({ v: VERSION })];
    for (const row of this.rows.values()) parts.push(JSON.stringify(row));
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, `${parts.join('\n')}\n`);
    } catch (err) {
      log.warn(`could not save the ${this.name} index`, err);
    }
  }

  /** The conversation text of `path`, lower-cased (cached). */
  lowerText(path: string): string {
    let v = this.lc.get(path);
    if (v === undefined) {
      v = this.rows.get(path)?.conv?.text.toLowerCase() ?? '';
      this.lc.set(path, v);
    }
    return v;
  }

  /** Every indexed conversation with its file's mtime. */
  conversations(): Array<Conversation & { mtime: number; path: string }> {
    const out: Array<Conversation & { mtime: number; path: string }> = [];
    for (const row of this.rows.values()) if (row.conv !== undefined) out.push({ ...row.conv, mtime: row.mtime, path: row.path });
    return out;
  }
}

/**
 * Stream a file's lines to `visit` without holding it in memory. Lines longer
 * than `maxLine` (base64 images, huge tool output) are skipped unparsed.
 */
export async function eachJsonLine(
  path: string,
  visit: (entry: Record<string, unknown>, raw: string) => void,
  maxLine = 1_000_000,
): Promise<void> {
  const decoder = new TextDecoder();
  let carry = '';
  let skipping = false;
  const handle = (line: string): void => {
    if (line === '' || line.length > maxLine) return;
    const v = parseJson(line);
    if (isRecord(v)) visit(v, line);
  };
  for await (const chunk of Bun.file(path).stream()) {
    let text = carry + decoder.decode(chunk, { stream: true });
    let nl = text.indexOf('\n');
    while (nl >= 0) {
      if (!skipping) handle(text.slice(0, nl));
      skipping = false;
      text = text.slice(nl + 1);
      nl = text.indexOf('\n');
    }
    if (text.length > maxLine) {
      skipping = true; // drop the rest of this over-long line
      text = '';
    }
    carry = text;
  }
  if (!skipping) handle(carry + decoder.decode());
}
