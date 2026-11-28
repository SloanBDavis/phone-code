/**
 * Codex rollouts, for the "All chats" index (history/service.ts): which files
 * there are and the title, folder and text of each.
 */
import path from 'node:path';
import { capText, eachJsonLine, type Conversation, type FileStat } from '../../history/index-file.ts';
import { filesIn, statAll, subdirs } from '../../history/sources.ts';
import { arr, isRec, mapPool, oneLine, rec, str } from '../shared/common.ts';
import { codexHome } from './history.ts';

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
  const flags = { sub: false };
  let title: string | undefined;
  let count = 0;
  const pieces: string[] = [];
  await eachJsonLine(f.path, (e) => {
    const p = rec(e.payload);
    if (e.type === 'session_meta') {
      id ??= str(p.id) ?? str(p.session_id);
      cwd ??= str(p.cwd);
      const source = p.source;
      if (isRec(source) && ('subagent' in source || 'subAgent' in source)) flags.sub = true;
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
  if (flags.sub || id === undefined || cwd === undefined || title === undefined) return undefined;
  return { resumeId: id, cwd, title: oneLine(title, 100), messageCount: count, text: capText(pieces) };
}
