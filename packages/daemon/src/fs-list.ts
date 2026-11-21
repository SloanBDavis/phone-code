import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FsListResult } from '@phone-code/protocol';
import { UserError } from './util/errors.ts';

const MAX_ENTRIES = 5000;

/** Expand `~` / `~/x` and resolve against the home directory. */
export function expandPath(input: string | undefined): string {
  const home = homedir();
  if (input === undefined || input.trim() === '' || input === '~') return home;
  if (input.startsWith('~/')) return join(home, input.slice(2));
  return isAbsolute(input) ? resolve(input) : resolve(home, input);
}

/** A user-facing error message; never includes stack traces. */
export class FsError extends UserError {}

function describe(err: unknown, path: string): FsError {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
  switch (code) {
    case 'ENOENT':
      return new FsError(`No such directory: ${path}`);
    case 'EACCES':
    case 'EPERM':
      return new FsError(`Permission denied: ${path}`);
    case 'ENOTDIR':
      return new FsError(`Not a directory: ${path}`);
    default:
      return new FsError(`Cannot read ${path}`);
  }
}

export async function assertDirectory(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) throw new FsError(`Not a directory: ${path}`);
  } catch (err) {
    throw err instanceof FsError ? err : describe(err, path);
  }
}

export async function listDirectory(input: string | undefined): Promise<FsListResult> {
  const path = expandPath(input);
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    throw describe(err, path);
  }
  const entries = await Promise.all(
    dirents.slice(0, MAX_ENTRIES).map(async (d) => {
      let dir = d.isDirectory();
      if (d.isSymbolicLink()) {
        dir = await stat(join(path, d.name)).then(
          (s) => s.isDirectory(),
          () => false,
        );
      }
      return { name: d.name, dir, hidden: d.name.startsWith('.') };
    }),
  );
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  const parent = dirname(path);
  return { path, ...(parent === path ? {} : { parent }), entries };
}
