/**
 * Codex rollout files: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`.
 * Line 1 is `session_meta` (cwd, id, source); the first real prompt is a
 * `response_item` message with role user that is not an injected
 * `<environment_context>` / `<user_instructions>` block.
 */
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResumableSession } from '@phone-code/protocol';
import { arr, isRec, mapPool, oneLine, rec, str, type Rec } from '../shared/common.ts';

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const CHUNK = 64 * 1024;
const MAX_SCAN = 1024 * 1024;

/** Feed complete lines of `text` to `visit`; returns [stop, rest]. */
function eatLines(text: string, visit: (entry: Rec) => boolean): [boolean, string] {
  let rest = text;
  let nl = rest.indexOf('\n');
  while (nl >= 0) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    nl = rest.indexOf('\n');
    // Cheap prefilter: only parse lines that can matter (the meta line and user messages).
    if (
      !line.includes('"session_meta"') &&
      !line.includes('"role":"user"') &&
      !line.includes('"user_message"')
    )
      continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRec(v) && visit(v)) return [true, rest];
    } catch {
      // ignore
    }
  }
  return [false, rest];
}

/** Stream the head of a file line by line until `visit` returns true or MAX_SCAN bytes were read. */
async function scanHead(file: string, visit: (entry: Rec) => boolean): Promise<void> {
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(CHUNK);
  const step = async (handle: FileHandle, pos: number, carry: string): Promise<void> => {
    if (pos >= MAX_SCAN) return;
    const { bytesRead } = await handle.read(buf, 0, CHUNK, pos);
    if (bytesRead === 0) return;
    const [stop, rest] = eatLines(carry + buf.subarray(0, bytesRead).toString('utf8'), visit);
    if (stop) return;
    return step(handle, pos + bytesRead, rest);
  };
  try {
    await step(fh, 0, '');
  } finally {
    await fh.close();
  }
}

function promptOf(entry: Rec): string | undefined {
  const p = rec(entry.payload);
  if (entry.type === 'event_msg' && p.type === 'user_message') return str(p.message);
  if (entry.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') return undefined;
  const text = arr(p.content)
    .map(rec)
    .filter((c) => c.type === 'input_text')
    .map((c) => str(c.text) ?? '')
    .join('\n')
    .trim();
  if (!text || text.startsWith('<')) return undefined;
  return text;
}

interface Head {
  id?: string;
  cwd?: string;
  title?: string;
  sub: boolean;
}

async function summarize(file: string): Promise<ResumableSession | undefined> {
  const head: Head = { sub: false };
  await scanHead(file, (e) => {
    if (e.type === 'session_meta') {
      const p = rec(e.payload);
      head.id = str(p.id) ?? str(p.session_id);
      head.cwd = str(p.cwd);
      const source = p.source;
      // Sub-agent threads are not resumable on their own.
      head.sub = isRec(source) && ('subagent' in source || 'subAgent' in source);
      return head.sub;
    }
    head.title = promptOf(e);
    return head.title !== undefined;
  });
  if (head.sub || !head.id || !head.cwd || !head.title) return undefined;
  const st = await stat(file);
  return {
    agent: 'codex',
    resumeId: head.id,
    cwd: head.cwd,
    title: oneLine(head.title, 100),
    updatedAt: Math.round(st.mtimeMs),
  };
}

async function listDirDesc(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(filter).toSorted().toReversed();
  } catch {
    return [];
  }
}

const isNum2 = (n: string): boolean => /^\d{2}$/.test(n);

export async function listCodexResumable(
  limit = 50,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResumableSession[]> {
  const root = path.join(codexHome(env), 'sessions');
  // Directory names are dates, so newest-first traversal can stop early.
  const years = await listDirDesc(root, (n) => /^\d{4}$/.test(n));
  const months = (
    await Promise.all(
      years.map(async (y) =>
        (await listDirDesc(path.join(root, y), isNum2)).map((m) => path.join(root, y, m)),
      ),
    )
  ).flat();
  const days = (
    await Promise.all(months.map(async (m) => (await listDirDesc(m, isNum2)).map((d) => path.join(m, d))))
  ).flat();
  const want = limit * 3 + 20; // some files are sub-agents or empty
  const files: string[] = [];
  const collect = async (i: number): Promise<void> => {
    const day = days[i];
    if (day === undefined || files.length >= want) return;
    const names = await listDirDesc(day, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    files.push(...names.map((n) => path.join(day, n)));
    return collect(i + 1);
  };
  await collect(0);
  const sums = await mapPool(files.slice(0, want), 16, async (f) => {
    try {
      return await summarize(f);
    } catch {
      return undefined;
    }
  });
  return sums
    .filter((s): s is ResumableSession => s !== undefined)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
