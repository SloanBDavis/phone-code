/**
 * Codex app-server ThreadItems -> ChatItems. Shapes follow the bindings that
 * `codex app-server generate-ts` (codex-cli 0.171.0) emits; see codex.ts.
 */
import type { ChatItem, ToolDetail, ToolItem, ToolStatus } from '@phone-code/protocol';
import { arr, displayPath, num, oneLine, rec, str, truncateOutput, type Rec } from './shared/common.ts';
import { countPatch } from './shared/diff.ts';

/** `bash -lc 'npm test'` -> `npm test` */
export function unwrapShell(command: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (!m || m[2] === undefined) return command;
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\"/g, '"');
}

function execStatus(s: unknown, exitCode?: number): ToolStatus {
  switch (s) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return exitCode !== undefined && exitCode !== 0 ? 'error' : 'done';
    case 'declined':
      return 'denied';
    case 'failed':
      return 'error';
    default:
      return 'done';
  }
}

/** One combined unified diff for a fileChange item. */
export function fileChangeDetail(changes: unknown, cwd: string): { detail: ToolDetail; title: string } {
  const list = arr(changes).map(rec);
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  const paths: string[] = [];
  for (const c of list) {
    const p = displayPath(str(c.path) ?? '', cwd);
    paths.push(p);
    const kind = str(rec(c.kind).type) ?? 'update';
    const movePath = str(rec(c.kind).move_path);
    const diff = str(c.diff) ?? '';
    let body: string;
    if (/^@@ /m.test(diff)) {
      body = diff.replace(/^(---|\+\+\+) .*\n/gm, '');
    } else {
      // add / delete carry the whole file content
      const lines = diff.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const sign = kind === 'delete' ? '-' : '+';
      body = `@@ -${kind === 'delete' ? `1,${lines.length}` : '0,0'} +${kind === 'delete' ? '0,0' : `1,${lines.length}`} @@\n${lines.map((l) => sign + l).join('\n')}\n`;
    }
    const from = kind === 'add' ? '/dev/null' : `a/${p}`;
    const to = kind === 'delete' ? '/dev/null' : `b/${movePath ? displayPath(movePath, cwd) : p}`;
    const patch = `--- ${from}\n+++ ${to}\n${body.endsWith('\n') ? body : `${body}\n`}`;
    const counts = countPatch(patch);
    added += counts.added;
    removed += counts.removed;
    parts.push(patch);
  }
  const path = paths.length === 1 ? (paths[0] ?? '') : `${paths.length} files`;
  return {
    detail: { type: 'diff', path, patch: parts.join(''), added, removed },
    title: paths.length <= 2 ? paths.join(', ') : `${paths[0] ?? ''} +${paths.length - 1} more`,
  };
}

function mcpOutput(item: Rec): string {
  const err = str(rec(item.error).message);
  if (err) return err;
  const content = arr(rec(item.result).content);
  const texts = content.map((c) => {
    const r = rec(c);
    return r.type === 'text' ? (str(r.text) ?? '') : `[${str(r.type) ?? 'content'}]`;
  });
  return texts.join('\n');
}

/**
 * Map one ThreadItem. Returns undefined for items that are not shown (user
 * messages live, empty reasoning) or are handled elsewhere.
 * `prev` is the item's current ChatItem (to keep streamed output).
 */
export function mapThreadItem(
  itemValue: unknown,
  cwd: string,
  opts: { prev?: ChatItem; ts: number; history: boolean },
): ChatItem | undefined {
  const item = rec(itemValue);
  const id = str(item.id);
  if (!id) return undefined;
  const ts = opts.prev?.ts ?? opts.ts;
  const done = item.completedAtMs !== null && item.completedAtMs !== undefined;
  switch (item.type) {
    case 'userMessage': {
      if (!opts.history) return undefined;
      const text = arr(item.content)
        .map(rec)
        .filter((c) => c.type === 'text')
        .map((c) => str(c.text) ?? '')
        .join('\n');
      return { kind: 'user', id, ts, text };
    }
    case 'agentMessage':
      return { kind: 'text', id, ts, text: str(item.text) ?? '', streaming: !opts.history && !done };
    case 'plan':
      return { kind: 'text', id, ts, text: `**Plan**\n\n${str(item.text) ?? ''}`, streaming: false };
    case 'reasoning': {
      const summary = arr(item.summary).map((s) => String(s));
      const content = arr(item.content).map((s) => String(s));
      const text = (summary.length ? summary : content).join('\n\n');
      const prevText = opts.prev?.kind === 'thinking' ? opts.prev.text : '';
      if (!text && !prevText) return undefined;
      return { kind: 'thinking', id, ts, text: text || prevText, streaming: false };
    }
    case 'commandExecution': {
      const command = unwrapShell(str(item.command) ?? '');
      const exitCode = num(item.exitCode);
      const prevOut = opts.prev?.kind === 'tool' ? opts.prev.output : undefined;
      const raw = str(item.aggregatedOutput) ?? prevOut ?? '';
      const { output, truncated } = truncateOutput(raw);
      const tool: ToolItem = {
        kind: 'tool',
        id,
        ts,
        name: 'Bash',
        title: oneLine(command) || 'command',
        status: execStatus(item.status, exitCode),
        input: { command, cwd: str(item.cwd) },
        detail: {
          type: 'command',
          command,
          ...(str(item.cwd) ? { cwd: str(item.cwd) } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
        ...(output ? { output } : {}),
        ...(truncated ? { outputTruncated: true } : {}),
      };
      return tool;
    }
    case 'fileChange': {
      const { detail, title } = fileChangeDetail(item.changes, cwd);
      return {
        kind: 'tool',
        id,
        ts,
        name: 'Edit',
        title,
        status: execStatus(item.status),
        input: { changes: item.changes },
        detail,
      };
    }
    case 'mcpToolCall': {
      const server = str(item.server) ?? 'mcp';
      const tool = str(item.tool) ?? 'tool';
      const { output, truncated } = truncateOutput(mcpOutput(item));
      const status: ToolStatus =
        item.status === 'inProgress' ? 'running' : item.status === 'failed' || item.error ? 'error' : 'done';
      return {
        kind: 'tool',
        id,
        ts,
        name: `mcp__${server}__${tool}`,
        title: `${server}: ${tool}`,
        status,
        input: item.arguments,
        ...(output ? { output } : {}),
        ...(truncated ? { outputTruncated: true } : {}),
      };
    }
    case 'dynamicToolCall': {
      const tool = str(item.tool) ?? 'tool';
      const texts = arr(item.contentItems)
        .map(rec)
        .map((c) => str(c.text) ?? '')
        .filter(Boolean)
        .join('\n');
      const { output, truncated } = truncateOutput(texts);
      return {
        kind: 'tool',
        id,
        ts,
        name: tool,
        title: tool,
        status: item.status === 'inProgress' ? 'running' : item.success === false ? 'error' : 'done',
        input: item.arguments,
        ...(output ? { output } : {}),
        ...(truncated ? { outputTruncated: true } : {}),
      };
    }
    case 'webSearch': {
      const action = rec(item.action);
      const query = str(item.query) ?? str(action.query) ?? '';
      if (action.type === 'openPage' && str(action.url)) {
        const url = str(action.url) ?? '';
        return {
          kind: 'tool',
          id,
          ts,
          name: 'WebFetch',
          title: oneLine(url, 70),
          status: done ? 'done' : 'running',
          input: action,
          detail: { type: 'url', url },
        };
      }
      return {
        kind: 'tool',
        id,
        ts,
        name: 'WebSearch',
        title: `Search: ${oneLine(query, 60)}`,
        status: done || opts.history ? 'done' : 'running',
        input: { query },
        detail: { type: 'search', query },
      };
    }
    case 'imageView': {
      const p = displayPath(str(item.path) ?? '', cwd);
      return {
        kind: 'tool',
        id,
        ts,
        name: 'Read',
        title: p,
        status: 'done',
        input: { path: item.path },
        detail: { type: 'file', path: p },
      };
    }
    case 'collabAgentToolCall': {
      const prompt = str(item.prompt) ?? str(item.tool) ?? 'Sub-agent';
      const s = str(item.status);
      return {
        kind: 'tool',
        id,
        ts,
        name: 'Task',
        title: oneLine(prompt, 60),
        status: s === 'inProgress' ? 'running' : s === 'failed' ? 'error' : 'done',
        input: { tool: item.tool, prompt: item.prompt, model: item.model },
      };
    }
    case 'contextCompaction':
      return { kind: 'notice', id, ts, level: 'info', text: 'Conversation compacted' };
    case 'enteredReviewMode':
      return {
        kind: 'notice',
        id,
        ts,
        level: 'info',
        text: `Review started: ${oneLine(str(item.review) ?? '', 80)}`,
      };
    case 'exitedReviewMode':
      return { kind: 'text', id, ts, text: str(item.review) ?? 'Review finished', streaming: false };
    case 'hookPrompt':
    case 'functionCallOutput':
    case 'subAgentActivity':
    case 'sleep':
      return undefined;
    default: {
      // Unknown / future item type: show it as a generic tool card rather than dropping it.
      const type = str(item.type) ?? 'item';
      return {
        kind: 'tool',
        id,
        ts,
        name: type,
        title: type,
        status: done || opts.history ? 'done' : 'running',
        input: item,
      };
    }
  }
}
