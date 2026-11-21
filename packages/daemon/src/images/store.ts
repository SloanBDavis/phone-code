/**
 * Per-session image store under `<state>/images/<sessionId>/<id>.<ext>`.
 *
 * - Content-addressed: `id` is the first 32 hex digits of the SHA-256 of the
 *   bytes, so the same picture is stored once per session.
 * - The media type comes from the bytes (sniff.ts); anything that is not
 *   PNG, JPEG, GIF or WebP is refused.
 * - Caps: one image (PHONECODE_IMAGE_MAX_MB, default 10 MB), one session
 *   (default 200 MB) and a total disk budget (PHONECODE_IMAGE_BUDGET_MB,
 *   default 1024 MB) enforced by deleting the least recently used images,
 *   thumbnails included. Transcripts keep their refs; an evicted image
 *   answers 404.
 * - `put` is synchronous (it returns the ref at once, so adapters can attach
 *   refs while mapping a stream); the bytes stay in memory until written.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageRef } from '@phone-code/protocol';
import { log } from '../log.ts';
import { sniffImage, type Sniffed } from './sniff.ts';

const MB = 1024 * 1024;
const THUMB_WIDTHS = [64, 128, 256, 384, 512, 768, 1024, 1536, 2048];
/** Do not touch a file's mtime more often than this (it is the LRU clock across restarts). */
const TOUCH_EVERY_MS = 60 * 60 * 1000;

function envMb(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v * MB : fallback;
}

export const ID_RE = /^[0-9a-f]{32}$/;
const SESSION_RE = /^[\w-]{1,128}$/;
function isExt(v: string): v is Sniffed['ext'] {
  return v === 'png' || v === 'jpg' || v === 'gif' || v === 'webp';
}

const EXT_TYPES: Record<Sniffed['ext'], Sniffed['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

interface Entry {
  sessionId: string;
  id: string;
  ext: Sniffed['ext'];
  mediaType: Sniffed['mediaType'];
  bytes: number;
  /** Bytes of thumbnails made from it. */
  thumbBytes: number;
  lastUsed: number;
  /** Set until the file is on disk. */
  pending?: Uint8Array;
  written?: Promise<void>;
}

export type PutResult = { ok: true; ref: ImageRef } | { ok: false; error: string };

export interface ImageFile {
  body: Blob;
  mediaType: string;
}

function cleanName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const n = name.replaceAll(/[\p{Cc}\p{Cf}/\\]/gu, '').trim();
  return n === '' ? undefined : n.slice(0, 120);
}

export class ImageStore {
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private readonly loaded: Promise<void>;
  readonly maxImage = envMb('PHONECODE_IMAGE_MAX_MB', 10 * MB);
  readonly maxSession = envMb('PHONECODE_IMAGE_SESSION_MB', 200 * MB);
  readonly budget = envMb('PHONECODE_IMAGE_BUDGET_MB', 1024 * MB);

  constructor(readonly root: string) {
    this.loaded = this.scan().catch((err: unknown) => log.warn('image store scan failed', err));
  }

  private key(sessionId: string, id: string): string {
    return `${sessionId}/${id}`;
  }

  private dir(sessionId: string): string {
    return join(this.root, sessionId);
  }

  private file(e: Pick<Entry, 'sessionId' | 'id' | 'ext'>): string {
    return join(this.dir(e.sessionId), `${e.id}.${e.ext}`);
  }

  /** Rebuild the in-memory index (sizes and last use) from the files on disk. */
  private async scan(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const sessionId of await readdir(this.root)) {
      if (!SESSION_RE.test(sessionId)) continue;
      let names: string[];
      try {
        // oxlint-disable-next-line no-await-in-loop -- one directory at a time keeps startup light
        names = await readdir(this.dir(sessionId));
      } catch {
        continue;
      }
      const thumbs: Array<{ id: string; bytes: number }> = [];
      for (const name of names) {
        const m = /^([0-9a-f]{32})(?:\.w\d+)?\.(png|jpg|gif|webp)$/.exec(name);
        if (m?.[1] === undefined || m[2] === undefined) continue;
        let st;
        try {
          // oxlint-disable-next-line no-await-in-loop -- see above
          st = await stat(join(this.dir(sessionId), name));
        } catch {
          continue;
        }
        if (name.includes('.w')) {
          thumbs.push({ id: m[1], bytes: st.size });
          continue;
        }
        const key = this.key(sessionId, m[1]);
        if (this.entries.has(key)) continue;
        const ext = m[2];
        if (!isExt(ext)) continue;
        const mediaType = EXT_TYPES[ext];
        this.entries.set(key, {
          sessionId,
          id: m[1],
          ext,
          mediaType,
          bytes: st.size,
          thumbBytes: 0,
          lastUsed: st.mtimeMs,
        });
        this.total += st.size;
      }
      for (const t of thumbs) {
        const e = this.entries.get(this.key(sessionId, t.id));
        if (e !== undefined) {
          e.thumbBytes += t.bytes;
          this.total += t.bytes;
        }
      }
    }
    this.evict();
  }

  private sessionBytes(sessionId: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.sessionId === sessionId) n += e.bytes + e.thumbBytes;
    return n;
  }

  /** Store `bytes` for a session. Synchronous: the ref is valid at once (served from memory until written). */
  put(sessionId: string, bytes: Uint8Array, name?: string): PutResult {
    if (!SESSION_RE.test(sessionId)) return { ok: false, error: 'bad session id' };
    const sniffed = sniffImage(bytes);
    if (sniffed === undefined) return { ok: false, error: 'not a PNG, JPEG, GIF or WebP image' };
    if (bytes.length > this.maxImage)
      return { ok: false, error: `image is larger than ${Math.round(this.maxImage / MB)} MB` };
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const key = this.key(sessionId, id);
    const n = cleanName(name);
    const ref: ImageRef = {
      id,
      mediaType: sniffed.mediaType,
      bytes: bytes.length,
      ...(n === undefined ? {} : { name: n }),
      ...(sniffed.width === undefined ? {} : { width: sniffed.width, height: sniffed.height }),
    };
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.lastUsed = Date.now();
      return { ok: true, ref };
    }
    if (this.sessionBytes(sessionId) + bytes.length > this.maxSession)
      return { ok: false, error: 'this chat has reached its image storage limit' };
    const entry: Entry = {
      sessionId,
      id,
      ext: sniffed.ext,
      mediaType: sniffed.mediaType,
      bytes: bytes.length,
      thumbBytes: 0,
      lastUsed: Date.now(),
      pending: bytes,
    };
    this.entries.set(key, entry);
    this.total += bytes.length;
    entry.written = (async () => {
      await mkdir(this.dir(sessionId), { recursive: true, mode: 0o700 });
      await writeFile(this.file(entry), bytes, { mode: 0o600 });
    })()
      .catch((err: unknown) => {
        log.warn(`could not store image ${key}`, err);
        this.drop(entry);
      })
      .finally(() => {
        entry.pending = undefined;
      });
    void this.loaded.then(() => this.evict(entry));
    return { ok: true, ref };
  }

  /** Store a base64 payload (agent output). */
  putBase64(sessionId: string, data: string, name?: string): PutResult {
    if (data.length > (this.maxImage * 4) / 3 + 4) return { ok: false, error: 'image too large' };
    return this.put(sessionId, Buffer.from(data, 'base64'), name);
  }

  /**
   * Store a local image file, but only when its real path (symlinks resolved)
   * is inside one of `roots` (themselves resolved). Returns undefined when the
   * file is outside, missing, not a regular file, too big or not an image.
   */
  async putFile(
    sessionId: string,
    path: string,
    roots: string[],
    name?: string,
  ): Promise<ImageRef | undefined> {
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      return undefined;
    }
    const allowed = await Promise.all(roots.map((r) => realpath(r).catch(() => undefined)));
    const inside = allowed.some(
      (r) => r !== undefined && r !== '/' && (real === r || real.startsWith(r.endsWith('/') ? r : `${r}/`)),
    );
    if (!inside) return undefined;
    try {
      const st = await stat(real);
      if (!st.isFile() || st.size > this.maxImage || st.size === 0) return undefined;
      const res = this.put(sessionId, await readFile(real), name);
      return res.ok ? res.ref : undefined;
    } catch {
      return undefined;
    }
  }

  /** Absolute path of a stored image, once it is on disk (for agents that read local files). */
  async pathOf(sessionId: string, id: string): Promise<string | undefined> {
    const e = this.entries.get(this.key(sessionId, id));
    if (e === undefined) return undefined;
    await e.written;
    return this.entries.has(this.key(sessionId, id)) ? this.file(e) : undefined;
  }

  /** Bytes of a stored image as base64 (for agents that take inline data). */
  async base64(sessionId: string, id: string): Promise<string | undefined> {
    const f = await this.get(sessionId, id);
    if (f === undefined) return undefined;
    return Buffer.from(await f.body.arrayBuffer()).toString('base64');
  }

  async get(sessionId: string, id: string, width?: number): Promise<ImageFile | undefined> {
    if (!SESSION_RE.test(sessionId) || !ID_RE.test(id)) return undefined;
    await this.loaded;
    const e = this.entries.get(this.key(sessionId, id));
    if (e === undefined) return undefined;
    const now = Date.now();
    if (now - e.lastUsed > TOUCH_EVERY_MS && e.pending === undefined) {
      const t = new Date(now);
      utimes(this.file(e), t, t).catch(() => undefined);
    }
    e.lastUsed = now;
    if (width !== undefined) {
      const thumb = await this.thumb(e, width);
      if (thumb !== undefined) return thumb;
    }
    if (e.pending !== undefined) return { body: new Blob([e.pending.slice()]), mediaType: e.mediaType };
    const file = Bun.file(this.file(e));
    if (!(await file.exists())) {
      this.drop(e);
      return undefined;
    }
    return { body: file, mediaType: e.mediaType };
  }

  /** A WebP no wider than `width` (rounded up to a fixed bucket), made with Bun.Image and cached. */
  private async thumb(e: Entry, width: number): Promise<ImageFile | undefined> {
    const w = THUMB_WIDTHS.find((b) => b >= width) ?? THUMB_WIDTHS.at(-1) ?? 2048;
    const path = join(this.dir(e.sessionId), `${e.id}.w${w}.webp`);
    const cached = Bun.file(path);
    if (await cached.exists()) return { body: cached, mediaType: 'image/webp' };
    try {
      await e.written;
      const src = e.pending ?? (await Bun.file(this.file(e)).bytes());
      const img = new Bun.Image(src, { maxPixels: 64_000_000 });
      const meta = await img.metadata();
      if (meta.width <= w) return undefined; // the original is small enough
      const out = await new Bun.Image(src, { maxPixels: 64_000_000 })
        .resize(w, undefined, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .bytes();
      await writeFile(path, out, { mode: 0o600 });
      e.thumbBytes += out.length;
      this.total += out.length;
      this.evict(e);
      return { body: new Blob([out.slice()]), mediaType: 'image/webp' };
    } catch (err) {
      log.debug(`thumbnail failed for ${e.sessionId}/${e.id}`, err);
      return undefined;
    }
  }

  private drop(e: Entry): void {
    const key = this.key(e.sessionId, e.id);
    if (this.entries.get(key) !== e) return;
    this.entries.delete(key);
    this.total -= e.bytes + e.thumbBytes;
  }

  /** Delete least recently used images until the store is under 90% of its budget. */
  private evict(keep?: Entry): void {
    if (this.total <= this.budget) return;
    const target = this.budget * 0.9;
    const victims = [...this.entries.values()]
      .filter((e) => e !== keep && e.pending === undefined)
      .toSorted((a, b) => a.lastUsed - b.lastUsed);
    for (const e of victims) {
      if (this.total <= target) break;
      this.drop(e);
      void this.removeFiles(e);
    }
  }

  private async removeFiles(e: Entry): Promise<void> {
    try {
      const names = await readdir(this.dir(e.sessionId));
      await Promise.all(
        names
          .filter((n) => n.startsWith(e.id))
          .map((n) => rm(join(this.dir(e.sessionId), n), { force: true })),
      );
    } catch {
      // already gone
    }
  }

  /** Forget every image of a deleted session. */
  async removeSession(sessionId: string): Promise<void> {
    if (!SESSION_RE.test(sessionId)) return;
    for (const e of this.entries.values()) if (e.sessionId === sessionId) this.drop(e);
    await rm(this.dir(sessionId), { recursive: true, force: true });
  }

  /** Total bytes on disk (tests and logs). */
  get usedBytes(): number {
    return this.total;
  }
}
