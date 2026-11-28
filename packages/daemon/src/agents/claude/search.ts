/**
 * Claude Code's session files, for the "All chats" index (history/service.ts):
 * which files there are and the title, folder and text of each.
 */
import path from 'node:path';
import { capText, eachJsonLine, type Conversation, type FileStat } from '../../history/index-file.ts';
import { filesIn, statAll, subdirs } from '../../history/sources.ts';
import { arr, mapPool, oneLine, rec, str } from '../shared/common.ts';
import { claudeConfigDir, userPromptText } from './history.ts';

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
  // Mutated inside the line callback (an object, so the checks below are not narrowed away).
  const flags = { sidechain: false };
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
      if (count === 0) flags.sidechain = true;
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
  if (flags.sidechain || cwd === undefined || title === undefined) return undefined;
  return {
    resumeId: path.basename(f.path, '.jsonl'),
    cwd,
    title: oneLine(title, 100),
    messageCount: count,
    ...(last > 0 ? { updatedAt: Math.max(last, 0) } : {}),
    text: capText(pieces),
  };
}
