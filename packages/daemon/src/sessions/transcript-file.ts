import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatItem } from '@phone-code/protocol';
import { log } from '../log.ts';
import { writeFileAtomic } from '../util/files.ts';
import { isRecord, parseJson } from '../util/guards.ts';

const ITEM_KINDS = new Set(['user', 'text', 'thinking', 'tool', 'permission', 'question', 'notice', 'turn']);

/** Shallow check: our own files only ever contain items we serialized. */
function isChatItem(v: unknown): v is ChatItem {
  return (
    isRecord(v) && typeof v['id'] === 'string' && typeof v['kind'] === 'string' && ITEM_KINDS.has(v['kind'])
  );
}

const FLUSH_MS = 250;

/**
 * Append-only JSONL transcript: one line per item state. The last line for an
 * id wins; order is the order of first appearance. Writes are buffered and
 * coalesced (a streaming text item is written once per flush, not per delta).
 */
export class TranscriptFile {
  private dirty = new Map<string, ChatItem>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private lines = 0;
  readonly path: string;

  constructor(
    dir: string,
    private readonly sessionId: string,
  ) {
    this.path = join(dir, `${sessionId}.jsonl`);
  }

  async load(): Promise<ChatItem[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const items = new Map<string, ChatItem>();
    for (const line of text.split('\n')) {
      if (line === '') continue;
      this.lines += 1;
      // A torn final line after a crash fails to parse and is skipped.
      const item = parseJson(line);
      if (isChatItem(item)) items.set(item.id, item);
    }
    const list = [...items.values()].map(settle);
    if (this.lines > list.length * 2 + 64) this.compact(list);
    return list;
  }

  /** Record the current state of an item (call again after every mutation). */
  touch(item: ChatItem): void {
    this.dirty.delete(item.id);
    this.dirty.set(item.id, item);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_MS);
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.dirty.size === 0) return this.chain;
    let chunk = '';
    for (const item of this.dirty.values()) chunk += `${JSON.stringify(item)}\n`;
    this.lines += this.dirty.size;
    this.dirty.clear();
    this.chain = this.chain
      .then(async () => {
        await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
        await appendFile(this.path, chunk, { mode: 0o600 });
        return undefined;
      })
      .catch((err: unknown) => log.error(`transcript write failed for ${this.sessionId}`, err));
    return this.chain;
  }

  private compact(items: ChatItem[]): void {
    const data = items.map((i) => JSON.stringify(i)).join('\n') + '\n';
    this.lines = items.length;
    this.chain = this.chain
      .then(() => writeFileAtomic(this.path, data))
      .catch((err: unknown) => log.warn(`transcript compaction failed for ${this.sessionId}`, err));
  }

  async remove(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.dirty.clear();
    await this.chain;
    await rm(this.path, { force: true });
  }
}

/** Items restored from disk can no longer be streaming or pending. */
function settle(item: ChatItem): ChatItem {
  if ((item.kind === 'text' || item.kind === 'thinking') && item.streaming)
    return { ...item, streaming: false };
  if (item.kind === 'tool' && item.status === 'running') {
    return { ...item, status: 'error', output: item.output ?? 'Interrupted' };
  }
  if ((item.kind === 'permission' || item.kind === 'question') && item.status === 'pending') {
    return { ...item, status: 'cancelled' };
  }
  return item;
}
