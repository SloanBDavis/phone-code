/**
 * Reading conversation files for the "All chats" indexes: helpers a harness's
 * own `history` source uses (agents/<harness>/search.ts), and phone-code's
 * own transcripts.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { mapPool, str } from '../agents/shared/common.ts';
import { capText, eachJsonLine, type Conversation, type FileStat } from './index-file.ts';

export async function statAll(files: string[]): Promise<FileStat[]> {
  const out = await mapPool(files, 32, async (file) => {
    try {
      const st = await stat(file);
      return st.isFile() && st.size > 0
        ? { path: file, size: st.size, mtime: Math.round(st.mtimeMs) }
        : undefined;
    } catch {
      return undefined;
    }
  });
  return out.filter((f): f is FileStat => f !== undefined);
}

export async function subdirs(dir: string, re?: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && (re === undefined || re.test(d.name)))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

export async function filesIn(dir: string, test: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && test(d.name))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

// ------------------------------------------------------ phone-code itself

/** `<state>/transcripts/<sessionId>.jsonl` */
export async function listTranscriptFiles(dir: string): Promise<FileStat[]> {
  return statAll(await filesIn(dir, (n) => n.endsWith('.jsonl')));
}

/** Our own transcript (last line per item id wins): user and assistant text, for search. */
export async function extractTranscript(f: FileStat): Promise<Conversation | undefined> {
  const texts = new Map<string, string>();
  await eachJsonLine(f.path, (e) => {
    const id = str(e.id);
    if (id === undefined) return;
    if (e.kind === 'user' || e.kind === 'text') texts.set(id, str(e.text) ?? '');
  });
  // resumeId is the phone-code session id here; cwd and title come from sessions.json.
  return {
    resumeId: path.basename(f.path, '.jsonl'),
    cwd: '',
    title: '',
    text: capText([...texts.values()]),
  };
}
