/**
 * The web app's files. Only files in this index are ever served, which rules
 * out path traversal by construction. The directory is packages/web/dist in
 * the repo, or the copy embedded in the compiled executable (`$bunfs`), with
 * brotli-precompressed `<file>.br` siblings produced by scripts/build.ts.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { log } from '../log.ts';

export interface Asset {
  file: Bun.BunFile;
  br: Bun.BunFile | undefined;
  type: string;
  etag: string;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
};

export function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

export class WebAssets {
  private index = new Map<string, Asset>();
  private watcher: FSWatcher | undefined;
  private reindexTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(readonly root: string | undefined) {}

  static async fromDisk(root: string): Promise<WebAssets> {
    const w = new WebAssets(root);
    await w.reindex();
    if (root.startsWith('/$bunfs/')) return w; // embedded files never change
    try {
      w.watcher = watch(root, { recursive: true }, () => w.scheduleReindex());
    } catch {
      // Watching is a dev nicety only.
    }
    return w;
  }

  /** Placeholder when the web app has not been built. */
  static empty(): WebAssets {
    return new WebAssets(undefined);
  }

  get size(): number {
    return this.index.size;
  }

  get(path: string): Asset | undefined {
    return this.index.get(path);
  }

  paths(): string[] {
    return [...this.index.keys()];
  }

  close(): void {
    this.watcher?.close();
    if (this.reindexTimer !== undefined) clearTimeout(this.reindexTimer);
  }

  private scheduleReindex(): void {
    this.reindexTimer ??= setTimeout(() => {
      this.reindexTimer = undefined;
      this.reindex().catch((err: unknown) => log.warn('web asset reindex failed', err));
    }, 150);
  }

  private async reindex(): Promise<void> {
    const root = this.root;
    if (root === undefined) return;
    const names = await readdir(root, { recursive: true });
    // Embedded files have no mtime: tag them by content instead.
    const embedded = root.startsWith('/$bunfs/');
    const next = new Map<string, Asset>();
    const brotli = new Set(names.filter((n) => n.endsWith('.br')));
    await Promise.all(
      names.map(async (name) => {
        if (name.endsWith('.br') || name.endsWith('.gz')) return;
        const full = join(root, name);
        const s = await stat(full).catch(() => undefined);
        if (s === undefined || !s.isFile()) return;
        const key = relative(root, full).split(sep).join('/');
        next.set(key, {
          file: Bun.file(full),
          br: brotli.has(`${name}.br`) ? Bun.file(`${full}.br`) : undefined,
          type: contentType(key),
          etag: embedded
            ? `W/"${Bun.hash(await Bun.file(full).bytes()).toString(36)}"`
            : `W/"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"`,
        });
      }),
    );
    this.index = next;
  }
}
