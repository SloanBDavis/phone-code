/**
 * Claude Code tool calls -> normalized ToolItem name / title / detail.
 * Input shapes follow `sdk-tools.d.ts` of @anthropic-ai/claude-agent-sdk 0.3.330
 * (Claude Code 2.1.330); unknown tools fall back to their raw name.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDetail } from '@phone-code/protocol';
import { arr, displayPath, isRec, oneLine, rec, str, type Rec } from '../shared/common.ts';
import { lineIndexOf, unifiedDiff } from '../shared/diff.ts';

const NAME_MAP: Record<string, string> = {
  Bash: 'Bash',
  BashOutput: 'Bash',
  PowerShell: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Glob: 'Glob',
  Grep: 'Grep',
  LS: 'Glob',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  TodoWrite: 'Todo',
  Task: 'Task',
  Agent: 'Task',
};

export function normalizeToolName(raw: string): string {
  return NAME_MAP[raw] ?? raw;
}

/** Tools that are rendered as something other than a tool card. */
export const HIDDEN_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const MAX_FILE_FOR_DIFF = 2 * 1024 * 1024;

export interface ToolView {
  name: string;
  title: string;
  detail?: ToolDetail;
}

function editsOf(rawName: string, input: Rec): Array<{ old: string; new: string; all: boolean }> {
  if (rawName === 'MultiEdit') {
    return arr(input.edits)
      .filter(isRec)
      .map((e) => ({
        old: str(e.old_string) ?? '',
        new: str(e.new_string) ?? '',
        all: e.replace_all === true,
      }));
  }
  return [
    { old: str(input.old_string) ?? '', new: str(input.new_string) ?? '', all: input.replace_all === true },
  ];
}

function applyEdits(
  content: string,
  edits: Array<{ old: string; new: string; all: boolean }>,
): string | undefined {
  let out = content;
  for (const e of edits) {
    if (e.old === '') {
      if (out !== '') return undefined;
      out = e.new;
      continue;
    }
    if (!out.includes(e.old)) return undefined;
    out = e.all ? out.split(e.old).join(e.new) : out.replace(e.old, () => e.new);
  }
  return out;
}

/**
 * Diff for a file-mutating tool. `original` is the file content before the
 * change when known (from disk or from the tool result's `originalFile`).
 */
export function fileDiff(
  rawName: string,
  input: Rec,
  cwd: string,
  original: string | null | undefined,
): ToolDetail | undefined {
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? '';
  const shown = displayPath(filePath, cwd);
  if (rawName === 'Write') {
    const content = str(input.content) ?? '';
    const d = unifiedDiff(original ?? '', content, shown, {
      isNew: original === null || original === undefined,
    });
    return { type: 'diff', path: shown, ...d };
  }
  if (rawName === 'Edit' || rawName === 'MultiEdit') {
    const edits = editsOf(rawName, input);
    if (typeof original === 'string') {
      const next = applyEdits(original, edits);
      if (next !== undefined) return { type: 'diff', path: shown, ...unifiedDiff(original, next, shown) };
    }
    // File unknown: diff the fragments; locate the first one for line numbers if we can.
    let patch = '';
    let added = 0;
    let removed = 0;
    for (const e of edits) {
      const at = typeof original === 'string' ? lineIndexOf(original, e.old) : -1;
      const d = unifiedDiff(e.old, e.new, shown, { lineOffset: Math.max(0, at) });
      patch += patch ? d.patch.split('\n').slice(2).join('\n') : d.patch;
      added += d.added;
      removed += d.removed;
    }
    return { type: 'diff', path: shown, patch, added, removed };
  }
  if (rawName === 'NotebookEdit') {
    const mode = str(input.edit_mode) ?? 'replace';
    const src = str(input.new_source) ?? '';
    const before =
      typeof original === 'string' ? notebookCellSource(original, str(input.cell_id)) : undefined;
    const d =
      mode === 'delete'
        ? unifiedDiff(before ?? '', '', shown)
        : unifiedDiff(mode === 'insert' ? '' : (before ?? ''), src, shown);
    return { type: 'diff', path: shown, ...d };
  }
  return undefined;
}

function notebookCellSource(nb: string, cellId: string | undefined): string | undefined {
  if (!cellId) return undefined;
  try {
    const parsed: unknown = JSON.parse(nb);
    for (const cell of arr(rec(parsed).cells)) {
      const c = rec(cell);
      if (c.id === cellId) {
        const s = c.source;
        return Array.isArray(s) ? s.map((x) => String(x)).join('') : (str(s) ?? '');
      }
    }
  } catch {
    // not JSON
  }
  return undefined;
}

/** Synchronous best view from the input alone. */
export function describeTool(rawName: string, inputValue: unknown, cwd: string): ToolView {
  const input = rec(inputValue);
  const name = normalizeToolName(rawName);
  const fp = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? '';
  switch (rawName) {
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command) ?? '';
      return { name, title: oneLine(command) || 'command', detail: { type: 'command', command, cwd } };
    }
    case 'BashOutput':
      return { name, title: `Output of ${str(input.bash_id) ?? 'background shell'}` };
    case 'Read':
      return { name, title: displayPath(fp, cwd), detail: { type: 'file', path: displayPath(fp, cwd) } };
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { name, title: displayPath(fp, cwd), detail: fileDiff(rawName, input, cwd, undefined) };
    case 'Glob': {
      const pattern = str(input.pattern) ?? '';
      const p = str(input.path);
      return {
        name,
        title: pattern,
        detail: { type: 'search', query: pattern, ...(p ? { path: displayPath(p, cwd) } : {}) },
      };
    }
    case 'LS':
      return {
        name,
        title: displayPath(fp, cwd),
        detail: { type: 'search', query: '*', path: displayPath(fp, cwd) },
      };
    case 'Grep': {
      const pattern = str(input.pattern) ?? '';
      const p = str(input.path);
      return {
        name,
        title: `Search: ${oneLine(pattern, 60)}`,
        detail: { type: 'search', query: pattern, ...(p ? { path: displayPath(p, cwd) } : {}) },
      };
    }
    case 'WebFetch': {
      const url = str(input.url) ?? '';
      return { name, title: shortUrl(url), detail: { type: 'url', url } };
    }
    case 'WebSearch': {
      const q = str(input.query) ?? '';
      return { name, title: `Search: ${oneLine(q, 60)}`, detail: { type: 'search', query: q } };
    }
    case 'TodoWrite': {
      const todos = todosOf(input);
      const active = todos.find((t) => t.status === 'in_progress');
      const done = todos.filter((t) => t.status === 'completed').length;
      return {
        name,
        title: active ? oneLine(active.text, 60) : `${done}/${todos.length} done`,
        detail: { type: 'todos', todos },
      };
    }
    case 'Task':
    case 'Agent': {
      const desc = str(input.description) ?? oneLine(str(input.prompt) ?? 'Sub-agent', 60);
      const kind = str(input.subagent_type);
      return { name, title: kind && kind !== 'general-purpose' ? `${desc} (${kind})` : desc };
    }
    default:
      return { name, title: genericTitle(rawName, input) };
  }
}

export function todosOf(
  input: Rec,
): Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> {
  return arr(input.todos)
    .filter(isRec)
    .map((t) => {
      const s = str(t.status);
      const status: 'pending' | 'in_progress' | 'completed' =
        s === 'completed' || s === 'in_progress' ? s : 'pending';
      const text = (status === 'in_progress' ? str(t.activeForm) : undefined) ?? str(t.content) ?? '';
      return { text, status };
    });
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return oneLine(u.host + (u.pathname === '/' ? '' : u.pathname), 70);
  } catch {
    return oneLine(url, 70);
  }
}

function genericTitle(rawName: string, input: Rec): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(rawName);
  const label = mcp ? `${mcp[1]}: ${mcp[2]}` : rawName;
  for (const key of [
    'description',
    'title',
    'query',
    'command',
    'file_path',
    'path',
    'url',
    'name',
    'prompt',
  ]) {
    const v = str(input[key]);
    if (v) return `${label} · ${oneLine(v, 50)}`;
  }
  return label;
}

/**
 * Re-read the file being changed so the diff has real line numbers and
 * context. Resolves undefined when nothing better than the sync view exists.
 */
export async function refineFileDetail(
  rawName: string,
  inputValue: unknown,
  cwd: string,
): Promise<ToolDetail | undefined> {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(rawName)) return undefined;
  const input = rec(inputValue);
  const fp = str(input.file_path) ?? str(input.notebook_path);
  if (!fp) return undefined;
  const abs = path.isAbsolute(fp) ? fp : path.resolve(cwd, fp);
  let original: string | null;
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > MAX_FILE_FOR_DIFF) return undefined;
    original = await readFile(abs, 'utf8');
  } catch {
    original = null; // new file
  }
  return fileDiff(rawName, input, cwd, original);
}

/** Text of a tool_result `content` (string or content blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of arr(content)) {
    const b = rec(block);
    if (b.type === 'text') parts.push(str(b.text) ?? '');
    else if (b.type === 'image') parts.push('[image]');
    else if (b.type === 'tool_reference') parts.push(`[tool ${str(b.tool_name) ?? ''}]`);
  }
  return parts.join('\n');
}

/** Exit code for a Bash result: Claude Code reports non-zero exits as is_error with "Exit code N". */
export function bashExitCode(text: string, isError: boolean): number | undefined {
  const m = /(?:^|\n)Exit code (\d+)/.exec(text);
  if (m) return Number(m[1]);
  return isError ? undefined : 0;
}
