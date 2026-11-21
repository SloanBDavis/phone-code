/**
 * ACP (Agent Client Protocol v1) payloads -> phone-code ChatItems.
 *
 * Shapes follow schema/v1/schema.json of @agentclientprotocol/sdk 2.8.0 and
 * the spec repo at v1.20.0 (agentclientprotocol/agent-client-protocol).
 * Everything here is defensive: an agent's JSON is untrusted, fields may be
 * missing, and unknown variants must never throw.
 */
import type { PermissionMode, ToolDetail, ToolItem, ToolStatus } from '@phone-code/protocol';
import {
  arr,
  displayPath,
  isRec,
  num,
  oneLine,
  rec,
  str,
  truncateOutput,
  type Rec,
} from './shared/common.ts';
import { unifiedDiff } from './shared/diff.ts';

/** Accumulated state of one ACP tool call (`tool_call` + every `tool_call_update`). */
export interface AcpToolState {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  name?: string;
  content: Rec[];
  locations: Rec[];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Live output of client terminals embedded in `content`, by terminal id. */
  terminalOutput?: Map<string, { output: string; exitCode?: number | null }>;
}

/** Merge a `tool_call` or `tool_call_update` into the stored state (null/absent fields keep the old value). */
export function mergeToolCall(prev: AcpToolState | undefined, u: Rec): AcpToolState {
  const id = str(u.toolCallId) ?? prev?.toolCallId ?? '';
  const next: AcpToolState = prev
    ? { ...prev }
    : { toolCallId: id, title: '', kind: 'other', status: 'pending', content: [], locations: [] };
  const title = str(u.title);
  if (title !== undefined) next.title = title;
  const kind = str(u.kind);
  if (kind !== undefined) next.kind = kind;
  const status = str(u.status);
  if (status !== undefined) next.status = status;
  const name = str(u.name);
  if (name !== undefined) next.name = name;
  if (Array.isArray(u.content)) next.content = u.content.filter(isRec);
  if (Array.isArray(u.locations)) next.locations = u.locations.filter(isRec);
  if (u.rawInput !== undefined && u.rawInput !== null) next.rawInput = u.rawInput;
  if (u.rawOutput !== undefined && u.rawOutput !== null) next.rawOutput = u.rawOutput;
  return next;
}

/** Plain text of one ContentBlock (text, resource links and embedded text resources). */
export function blockText(block: unknown): string {
  const b = rec(block);
  switch (str(b.type) ?? '') {
    case 'text':
      return str(b.text) ?? '';
    case 'resource_link': {
      const uri = str(b.uri) ?? '';
      const label = str(b.title) ?? str(b.name) ?? uri;
      return uri ? `[${label}](${uri})` : label;
    }
    case 'resource': {
      const r = rec(b.resource);
      return str(r.text) ?? (str(r.uri) ? `[${str(r.uri)}](${str(r.uri)})` : '');
    }
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return '';
  }
}

function firstStr(o: Rec, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** Shell command from a tool's raw input (string, argv array, or the title). */
function commandOf(t: AcpToolState): string {
  const input = rec(t.rawInput);
  const c = input.command ?? input.cmd ?? input.commandLine ?? input.CommandLine; // CommandLine: Antigravity
  let cmd: string | undefined;
  if (typeof c === 'string') cmd = c;
  else if (Array.isArray(c)) cmd = c.map(String).join(' ');
  if (cmd !== undefined) {
    const args = arr(input.args).filter((a): a is string => typeof a === 'string');
    if (args.length > 0 && typeof c === 'string') cmd = `${cmd} ${args.join(' ')}`;
    // `bash -lc '...'` wrappers: show the inner command.
    const m = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(cmd.trim());
    return m?.[2] ?? cmd;
  }
  return t.title.replace(/^`|`$/g, '');
}

function pathOf(t: AcpToolState): string | undefined {
  const loc = str(t.locations[0]?.path);
  if (loc) return loc;
  const input = rec(t.rawInput);
  const p = firstStr(input, ['path', 'file_path', 'filePath', 'absolute_path', 'file', 'filename', 'target']);
  if (p) return p;
  const diff = t.content.find((c) => c.type === 'diff');
  return str(diff?.path);
}

/** Diff detail over every `diff` content entry (multi-file edits are concatenated). */
export function diffDetail(
  content: Rec[],
  cwd: string,
): { detail: ToolDetail; path: string; isNew: boolean } | undefined {
  const diffs = content.filter((c) => c.type === 'diff' && typeof c.path === 'string');
  if (diffs.length === 0) return undefined;
  let patch = '';
  let added = 0;
  let removed = 0;
  let isNew = true;
  for (const d of diffs) {
    const shown = displayPath(str(d.path) ?? '', cwd);
    const oldText = str(d.oldText);
    if (oldText !== undefined) isNew = false;
    const u = unifiedDiff(oldText ?? '', str(d.newText) ?? '', shown, { isNew: oldText === undefined });
    patch += u.patch;
    added += u.added;
    removed += u.removed;
  }
  const path = displayPath(str(diffs[0]?.path) ?? '', cwd);
  return { detail: { type: 'diff', path, patch, added, removed }, path, isNew };
}

/** Text a tool produced: content blocks, terminal output, else rawOutput. */
function outputOf(t: AcpToolState): string {
  const parts: string[] = [];
  for (const c of t.content) {
    if (c.type === 'content') {
      const text = blockText(c.content);
      if (text) parts.push(text);
    } else if (c.type === 'terminal') {
      const term = t.terminalOutput?.get(str(c.terminalId) ?? '');
      if (term?.output) parts.push(term.output);
    }
  }
  if (parts.length > 0) return parts.join('\n');
  const raw = t.rawOutput;
  if (typeof raw === 'string') return raw;
  if (isRec(raw)) {
    const s = firstStr(raw, ['output', 'stdout', 'content', 'result', 'text', 'formatted_output']);
    if (s !== undefined) {
      const stderr = str(raw.stderr);
      return stderr ? `${s}\n${stderr}` : s;
    }
    const stderr = str(raw.stderr);
    if (stderr) return stderr;
  }
  return '';
}

function exitCodeOf(t: AcpToolState): number | undefined {
  for (const term of t.terminalOutput?.values() ?? []) {
    if (typeof term.exitCode === 'number') return term.exitCode;
  }
  const raw = rec(t.rawOutput);
  return num(raw.exitCode) ?? num(raw.exit_code) ?? num(raw.code);
}

function toolStatus(s: string): ToolStatus {
  switch (s) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'running'; // pending, in_progress, unknown
  }
}

/** Name, title and detail for a tool call, normalized across agents by ACP's `kind`. */
export function toolView(t: AcpToolState, cwd: string): { name: string; title: string; detail?: ToolDetail } {
  const input = rec(t.rawInput);
  const title = t.title || t.name || 'Tool';
  switch (t.kind) {
    case 'execute': {
      const command = commandOf(t);
      const cmdCwd = str(input.cwd) ?? str(input.workdir) ?? str(input.dir_path);
      const exitCode = exitCodeOf(t);
      return {
        name: 'Bash',
        title: oneLine(command || title, 80),
        detail: {
          type: 'command',
          command,
          ...(cmdCwd ? { cwd: cmdCwd } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
      };
    }
    case 'edit':
    case 'delete':
    case 'move': {
      const d = diffDetail(t.content, cwd);
      if (d)
        return { name: d.isNew && t.kind === 'edit' ? 'Write' : 'Edit', title: d.path, detail: d.detail };
      const p = pathOf(t);
      const verb = t.kind === 'delete' ? 'Delete' : t.kind === 'move' ? 'Move' : 'Edit';
      if (p)
        return {
          name: verb,
          title: displayPath(p, cwd),
          detail: { type: 'file', path: displayPath(p, cwd) },
        };
      return { name: verb, title: oneLine(title, 80) };
    }
    case 'read': {
      const p = pathOf(t);
      if (p)
        return {
          name: 'Read',
          title: displayPath(p, cwd),
          detail: { type: 'file', path: displayPath(p, cwd) },
        };
      return { name: 'Read', title: oneLine(title, 80) };
    }
    case 'search': {
      const query = firstStr(input, ['pattern', 'query', 'regex', 'glob', 'search', 'q']) ?? title;
      const p = firstStr(input, ['path', 'dir_path', 'directory', 'cwd']);
      const isGlob =
        input.glob !== undefined ||
        (input.pattern !== undefined &&
          /[*?[]/.test(str(input.pattern) ?? '') &&
          input.query === undefined &&
          !/grep|search/i.test(t.name ?? ''));
      return {
        name: isGlob ? 'Glob' : 'Grep',
        title: oneLine(query, 80),
        detail: { type: 'search', query, ...(p ? { path: displayPath(p, cwd) } : {}) },
      };
    }
    case 'fetch': {
      const url =
        firstStr(input, ['url', 'uri', 'href']) ?? (/^https?:\/\/\S+$/.test(title) ? title : undefined);
      if (url)
        return {
          name: 'WebFetch',
          title: oneLine(url.replace(/^https?:\/\//, ''), 80),
          detail: { type: 'url', url },
        };
      const query = firstStr(input, ['query', 'q', 'prompt']) ?? title;
      return { name: 'WebSearch', title: `Search: ${oneLine(query, 60)}`, detail: { type: 'search', query } };
    }
    case 'think':
      return { name: 'Think', title: oneLine(title, 80) };
    case 'switch_mode':
      return { name: 'Mode', title: oneLine(title, 80) };
    default:
      return { name: t.name || 'Tool', title: oneLine(title, 80) };
  }
}

/** The ToolItem for a tool call's current state. `denied` keeps a status we set when the user declined. */
export function toolItem(
  t: AcpToolState,
  id: string,
  cwd: string,
  ts: number,
  opts: { denied?: boolean } = {},
): ToolItem {
  const view = toolView(t, cwd);
  let status = toolStatus(t.status);
  if (opts.denied && status !== 'done') status = 'denied';
  const raw = outputOf(t);
  const { output, truncated } = truncateOutput(raw);
  return {
    kind: 'tool',
    id,
    ts,
    name: view.name,
    title: view.title,
    status,
    ...(t.rawInput !== undefined ? { input: t.rawInput } : {}),
    ...(view.detail ? { detail: view.detail } : {}),
    ...(output ? { output } : {}),
    ...(truncated ? { outputTruncated: true } : {}),
  };
}

/** ACP plan entries -> Todo detail. */
export function planTodos(
  entries: unknown,
): Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> {
  return arr(entries)
    .map(rec)
    .map((e) => {
      const s = str(e.status);
      const status: 'pending' | 'in_progress' | 'completed' =
        s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
      return { text: str(e.content) ?? '', status };
    });
}

/**
 * A readable message from a JSON-RPC error. Agents often wrap provider errors
 * as JSON inside `message` (Gemini CLI: `{"error":{"message":"{\n \"error\": ...`).
 */
export function rpcErrorText(err: unknown): string {
  let msg = str(rec(err).message) ?? (err instanceof Error ? err.message : String(err));
  // Gemini CLI: {code:-32603, message:"Internal error", data:{details:"Cannot enable …"}}
  const data = rec(err).data;
  const details = typeof data === 'string' ? data : (str(rec(data).details) ?? str(rec(data).message));
  if (details && details !== msg) msg = /^internal error$/i.test(msg.trim()) ? details : `${msg}: ${details}`;
  for (let i = 0; i < 4; i++) {
    const t = msg.trim();
    if (!t.startsWith('{')) break;
    try {
      const inner = rec(JSON.parse(t));
      const next = str(rec(inner.error).message) ?? str(inner.message);
      if (next === undefined) break;
      msg = next;
    } catch {
      break;
    }
  }
  return msg;
}

// ------------------------------------------------------------ modes, models

export interface AcpChoice {
  id: string;
  name: string;
  description?: string;
}

/** Values of a config option's `options` (flat or grouped). */
export function selectValues(options: unknown): AcpChoice[] {
  const out: AcpChoice[] = [];
  for (const o of arr(options).map(rec)) {
    if (Array.isArray(o.options)) {
      out.push(...selectValues(o.options));
      continue;
    }
    const id = str(o.value);
    if (id === undefined) continue;
    const description = str(o.description);
    out.push({ id, name: str(o.name) ?? id, ...(description ? { description } : {}) });
  }
  return out;
}

/**
 * Map an agent's own modes onto phone-code's PermissionMode, only where the
 * meaning is clear from the id/name/description:
 *   bypassPermissions  yolo, bypass…, full access, auto-approves all, dangerous
 *   acceptEdits        accept edits, auto edit, auto-approves edit(s)
 *   plan               plan, read-only, architect
 *   default            id "default"/"normal"/"manual"/"ask before…", else the
 *                      agent's initial mode when it is none of the above
 *                      (e.g. OpenCode's "build")
 * Anything else (e.g. "ask", "debug", custom agents) is not mapped and so is
 * not offered on the phone; the agent keeps whatever mode it is in.
 */
export function mapModes(modes: AcpChoice[], initialId: string | undefined): Map<PermissionMode, string> {
  const out = new Map<PermissionMode, string>();
  const classify = (m: AcpChoice): PermissionMode | undefined => {
    const id = m.id.toLowerCase();
    const text = `${id} ${m.name.toLowerCase()} ${(m.description ?? '').toLowerCase()}`;
    if (/yolo|bypass|full[ -_]?access|danger|approves all|approve all|never ask|skip permissions/.test(text))
      return 'bypassPermissions';
    if (/accept[ -_]?edits?|auto[ -_]?edit|approves edit|approve edit/.test(text)) return 'acceptEdits';
    if (/^plan|plan mode|read[ -_]?only|architect/.test(text)) return 'plan';
    if (/^(default|normal|manual)$/.test(id) || /ask before|prompts for approval/.test(text))
      return 'default';
    return undefined;
  };
  for (const m of modes) {
    const pm = classify(m);
    if (pm !== undefined && !out.has(pm)) out.set(pm, m.id);
  }
  if (!out.has('default') && initialId !== undefined && classify({ id: initialId, name: '' }) === undefined) {
    if (modes.some((m) => m.id === initialId)) out.set('default', initialId);
  }
  return out;
}

export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];
