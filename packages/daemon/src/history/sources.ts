/**
 * The conversation files each index reads, and how to read them:
 * Claude Code session files, Codex rollouts and phone-code's own transcripts.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { claudeConfigDir, userPromptText } from '../agents/claude-history.ts';
import { codexHome } from '../agents/codex-history.ts';
import { arr, isRec, mapPool, oneLine, rec, str } from '../agents/shared/common.ts';
import { capText, eachJsonLine, type Conversation, type FileStat } from './index-file.ts';

async function statAll(files: string[]): Promise<FileStat[]> {
  const out = await mapPool(files, 32, async (file) => {
    try {
      const st = await stat(file);
      return st.isFile() && st.size > 0 ? { path: file, size: st.size, mtime: Math.round(st.mtimeMs) } : undefined;
    } catch {
      return undefined;
    }
  });
  return out.filter((f): f is FileStat => f !== undefined);
}

async function subdirs(dir: string, re?: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && (re === undefined || re.test(d.name)))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

async function filesIn(dir: string, test: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && test(d.name))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- Claude Code

/** `~/.claude/projects/<slug>/<session>.jsonl` (top level only: sub-agent files live in sub-folders). */
export async function listClaudeFiles(env: NodeJS.ProcessEnv = process.env): Promise<FileStat[]> {
  const dirs = await subdirs(path.join(claudeConfigDir(env), 'projects'));
  const files = (await mapPool(dirs, 16, (d) => filesIn(d, (n) => n.endsWith('.jsonl')))).flat();
  return statAll(files);
}

/** Text of an assistant entry (text blocks only). */
function assistantText(e: Record<string, unknown>): string {
  const content = rec(e.message).content;
  if (typeof content === 'string') return content;
  return arr(content)
    .map(rec)
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

export async function extractClaude(f: FileStat): Promise<Conversation | undefined> {
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  let custom: string | undefined;
  let ai: string | undefined;
  let summary: string | undefined;
  let sidechain = false;
  let count = 0;
  let last = 0;
  const pieces: string[] = [];
  await eachJsonLine(f.path, (e) => {
    const type = e.type;
    if (cwd === undefined) cwd = str(e.cwd);
    if (type === 'custom-title') custom = str(e.customTitle) ?? custom;
    else if (type === 'ai-title') ai = str(e.aiTitle) ?? ai;
    else if (type === 'summary') summary ??= str(e.summary);
    if (type !== 'user' && type !== 'assistant') return;
    if (e.isSidechain === true) {
      if (count === 0) sidechain = true;
      return;
    }
    const ts = Date.parse(str(e.timestamp) ?? '');
    if (Number.isFinite(ts) && ts > last) last = ts;
    if (type === 'user') {
      const prompt = userPromptText(e);
      if (prompt === undefined) return;
      firstPrompt ??= prompt;
      count++;
      pieces.push(prompt);
    } else {
      count++;
      const t = assistantText(e);
      if (t !== '') pieces.push(t);
    }
  });
  const title = custom ?? ai ?? summary ?? firstPrompt;
  if (sidechain || cwd === undefined || title === undefined) return undefined;
  return {
    resumeId: path.basename(f.path, '.jsonl'),
    cwd,
    title: oneLine(title, 100),
    messageCount: count,
    ...(last > 0 ? { updatedAt: Math.max(last, 0) } : {}),
    text: capText(pieces),
  };
}

// ------------------------------------------------------------------ Codex

/** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` */
export async function listCodexFiles(env: NodeJS.ProcessEnv = process.env): Promise<FileStat[]> {
  const root = path.join(codexHome(env), 'sessions');
  const years = await subdirs(root, /^\d{4}$/);
  const months = (await Promise.all(years.map((y) => subdirs(y, /^\d{2}$/)))).flat();
  const days = (await Promise.all(months.map((m) => subdirs(m, /^\d{2}$/)))).flat();
  const files = (
    await mapPool(days, 16, (d) => filesIn(d, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')))
  ).flat();
  return statAll(files);
}

function codexText(content: unknown, kind: 'input_text' | 'output_text'): string {
  return arr(content)
    .map(rec)
    .filter((c) => c.type === kind)
    .map((c) => str(c.text) ?? '')
    .join('\n')
    .trim();
}

export async function extractCodex(f: FileStat): Promise<Conversation | undefined> {
  let id: string | undefined;
  let cwd: string | undefined;
  let sub = false;
  let title: string | undefined;
  let count = 0;
  const pieces: string[] = [];
  await eachJsonLine(f.path, (e) => {
    const p = rec(e.payload);
    if (e.type === 'session_meta') {
      id ??= str(p.id) ?? str(p.session_id);
      cwd ??= str(p.cwd);
      const source = p.source;
      if (isRec(source) && ('subagent' in source || 'subAgent' in source)) sub = true;
      return;
    }
    if (e.type !== 'response_item' || p.type !== 'message') return;
    if (p.role === 'user') {
      const t = codexText(p.content, 'input_text');
      if (t === '' || t.startsWith('<')) return; // injected <environment_context> etc.
      title ??= t;
      count++;
      pieces.push(t);
    } else if (p.role === 'assistant') {
      const t = codexText(p.content, 'output_text');
      count++;
      if (t !== '') pieces.push(t);
    }
  });
  if (sub || id === undefined || cwd === undefined || title === undefined) return undefined;
  return { resumeId: id, cwd, title: oneLine(title, 100), messageCount: count, text: capText(pieces) };
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
  return { resumeId: path.basename(f.path, '.jsonl'), cwd: '', title: '', text: capText([...texts.values()]) };
}
