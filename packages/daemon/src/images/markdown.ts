/**
 * Local images an agent references in its markdown: `![alt](path)`, a link
 * `[text](path.png)`, or an inline-code / bare path ending in an image
 * extension. Remote (http, data) URLs are left to the client.
 *
 * Confinement: a path is only ever read through ImageStore.putFile, which
 * resolves it with realpath (symlinks included) and accepts it only inside
 * the session's folder or the agent's own artifact directories (its
 * adapter's `artifactRoots`), and only when the bytes are a PNG, JPEG, GIF or
 * WebP within the size cap. Nothing else on the computer can be pulled out this way.
 */
import os from 'node:os';
import path from 'node:path';
import { IMAGE_EXT } from './sniff.ts';

const MAX_REFS = 8;

function clean(raw: string): string | undefined {
  let p = raw.trim().replace(/^<|>$/g, '');
  // `![x](path "title")`
  p = p.replace(/\s+"[^"]*"$/, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('file://')) return undefined; // http:, data:, ...
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return undefined;
    }
  } else {
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep as is
    }
  }
  if (!IMAGE_EXT.test(p) || p.length > 1024 || p.includes('\0')) return undefined;
  return p;
}

/** Candidate image paths in `text`, absolute (resolved against `cwd`), in order of appearance. */
export function imagePathsIn(text: string, cwd: string): string[] {
  const found: string[] = [];
  const add = (raw: string | undefined): void => {
    if (raw === undefined || found.length >= MAX_REFS) return;
    const p = clean(raw);
    if (p === undefined) return;
    const abs = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(cwd, p);
    if (!found.includes(abs)) found.push(abs);
  };
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) add(m[1]);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  for (const m of text.matchAll(
    /(?:^|[\s(])((?:~|\.{1,2})?\/[^\s`'"()<>]+\.(?:png|jpe?g|gif|webp))(?=$|[\s).,;:!?])/gim,
  ))
    add(m[1]);
  return found;
}
