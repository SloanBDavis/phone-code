/**
 * Claude Code session files: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`
 * (one JSON entry per line). Sub-agent transcripts live next to it in
 * `<sessionId>/subagents/agent-<agentId>.jsonl` (entries marked `isSidechain`),
 * each with an `agent-<agentId>.meta.json` naming the Agent/Task tool_use that
 * started it (`toolUseId`); older CLIs kept sidechain entries in the session
 * file itself, without a reliable link to their Task call. Used for the resume
 * picker and for replaying a past conversation into the chat when resuming.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatItem, ResumableSession } from '@phone-code/protocol';
import { ClaudeMapper, tsOf } from './claude-map.ts';
import { arr, isRec, mapPool, oneLine, rec, str, type Rec } from './shared/common.ts';

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 32 * 1024;

async function readSlice(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function parseLines(text: string, dropFirst: boolean, dropLast: boolean): Rec[] {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out: Rec[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRec(v)) out.push(v);
    } catch {
      // partial line at a slice boundary
    }
  }
  return out;
}

/** Text of a user prompt, or undefined when the entry is not a real typed prompt. */
export function userPromptText(entry: Rec): string | undefined {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return undefined;
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return undefined;
  const content = rec(entry.message).content;
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else {
    const parts = arr(content)
      .map(rec)
      .filter((b) => b.type === 'text')
      .map((b) => str(b.text) ?? '');
    if (arr(content).some((b) => rec(b).type === 'tool_result')) return undefined;
    text = parts.join('\n');
  }
  if (!text) return undefined;
  const t = text.trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:')) {
    // <command-name>, <local-command-stdout>, <system-reminder>, interruption markers
    const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
    return cmd ? cmd[1]?.trim() : undefined;
  }
  return t;
}

async function summarize(file: string, size: number, mtime: number): Promise<ResumableSession | undefined> {
  const head = parseLines(await readSlice(file, 0, Math.min(size, HEAD_BYTES)), false, size > HEAD_BYTES);
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  let sidechain = false;
  let count = 0;
  for (const e of head) {
    if (!cwd) cwd = str(e.cwd);
    if ((e.type === 'user' || e.type === 'assistant') && e.isSidechain === true) sidechain = true;
    if (!firstPrompt) firstPrompt = userPromptText(e);
    if ((e.type === 'user' && userPromptText(e)) || e.type === 'assistant') count++;
  }
  if (sidechain) return undefined;
  let title: string | undefined;
  if (size > HEAD_BYTES) {
    const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES);
    const tail = parseLines(await readSlice(file, tailStart, size - tailStart), true, false);
    for (const e of tail) {
      if (e.type === 'custom-title' && str(e.customTitle)) title = str(e.customTitle);
      else if (e.type === 'ai-title' && str(e.aiTitle) && !title) title = str(e.aiTitle);
      else if (e.type === 'summary' && str(e.summary) && !title) title = str(e.summary);
      if (!cwd) cwd = str(e.cwd);
    }
  } else {
    for (const e of head) {
      if (e.type === 'custom-title' && str(e.customTitle)) title = str(e.customTitle);
      else if ((e.type === 'ai-title' || e.type === 'summary') && !title)
        title = str(e.aiTitle) ?? str(e.summary);
    }
  }
  title = title ?? firstPrompt;
  if (!title || !cwd) return undefined; // nothing the user said: not worth resuming
  return {
    agent: 'claude',
    resumeId: path.basename(file, '.jsonl'), // what `claude --resume` looks up
    cwd,
    title: oneLine(title, 100),
    updatedAt: mtime,
    // Exact only when the whole file fit in the head read.
    ...(size <= HEAD_BYTES ? { messageCount: count } : {}),
  };
}

export async function listClaudeResumable(
  limit = 50,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResumableSession[]> {
  const root = path.join(claudeConfigDir(env), 'projects');
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
  // Stat every top-level session file (cheap), then read heads only for the newest.
  const perDir = await mapPool(dirs, 16, async (dir) => {
    try {
      const names = (await readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => path.join(dir, d.name));
      return await mapPool(names, 32, async (file) => {
        try {
          const st = await stat(file);
          return { file, size: st.size, mtime: st.mtimeMs };
        } catch {
          return undefined;
        }
      });
    } catch {
      return [];
    }
  });
  const files = perDir
    .flat()
    .filter((f): f is { file: string; size: number; mtime: number } => f !== undefined && f.size > 0)
    .toSorted((a, b) => b.mtime - a.mtime);
  const out: ResumableSession[] = [];
  // Summarize in newest-first batches until we have `limit` usable sessions.
  const batch = async (start: number): Promise<void> => {
    if (start >= files.length || out.length >= limit) return;
    const sums = await mapPool(files.slice(start, start + 32), 16, async (f) => {
      try {
        return await summarize(f.file, f.size, Math.round(f.mtime));
      } catch {
        return undefined;
      }
    });
    for (const s of sums) if (s && out.length < limit) out.push(s);
    return batch(start + 32);
  };
  await batch(0);
  return out;
}

/** Locate `<id>.jsonl`, trying the cwd's project dir first. */
export async function findSessionFile(
  id: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const root = path.join(claudeConfigDir(env), 'projects');
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const direct = path.join(root, slug, `${id}.jsonl`);
  try {
    await stat(direct);
    return direct;
  } catch {
    // scan
  }
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return undefined; // no projects dir
  }
  const hits = await mapPool(dirs, 32, async (d) => {
    const f = path.join(root, d, `${id}.jsonl`);
    try {
      await stat(f);
      return f;
    } catch {
      return undefined;
    }
  });
  return hits.find((f) => f !== undefined);
}

/**
 * Replay a session file into ChatItems. Follows the parentUuid chain from the
 * newest leaf so rewound branches are left out, and keeps at most `maxItems`.
 */
export async function loadClaudeTranscript(file: string, cwd: string, maxItems = 2000): Promise<ChatItem[]> {
  const text = await readFile(file, 'utf8');
  const entries = parseLines(text, false, false);
  const byUuid = new Map<string, Rec>();
  let leaf: Rec | undefined;
  for (const e of entries) {
    const uuid = str(e.uuid);
    if (!uuid) continue;
    byUuid.set(uuid, e);
    if ((e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true) leaf = e;
  }
  const chain: Rec[] = [];
  const seen = new Set<string>();
  let cur = leaf;
  while (cur) {
    const uuid = str(cur.uuid) ?? '';
    if (seen.has(uuid)) break;
    seen.add(uuid);
    chain.push(cur);
    const parent = str(cur.parentUuid) ?? str(cur.logicalParentUuid);
    cur = parent ? byUuid.get(parent) : undefined;
  }
  chain.reverse();

  const items = new Map<string, ChatItem>();
  const order: string[] = [];
  const sink = {
    upsert(item: ChatItem) {
      if (!items.has(item.id)) order.push(item.id);
      items.set(item.id, item);
    },
    delta() {},
  };
  const mapper = new ClaudeMapper(sink, cwd, false);
  for (const e of chain) {
    if (e.isSidechain === true) continue;
    if (e.type === 'assistant') mapper.onAssistant(e);
    else if (e.type === 'user') {
      const prompt = userPromptText(e);
      const content = rec(e.message).content;
      if (prompt) {
        sink.upsert({ kind: 'user', id: `u:${str(e.uuid) ?? order.length}`, ts: tsOf(e), text: prompt });
      } else if (arr(content).some((b) => rec(b).type === 'tool_result')) {
        mapper.onToolResults(e);
      } else if (
        typeof content === 'string'
          ? content.startsWith('[Request interrupted')
          : arr(content).some((b) => (str(rec(b).text) ?? '').startsWith('[Request interrupted'))
      ) {
        // A history kind (not a notice), so a daemon restart can drop it like the rest of the replay.
        sink.upsert({
          kind: 'turn',
          id: `turn:h:${str(e.uuid) ?? order.length}`,
          ts: tsOf(e),
          outcome: 'interrupted',
        });
      }
    }
    // compact_boundary entries are skipped: the summary that follows is not shown either.
  }
  await replaySubagents(file, chain, mapper);
  mapper.endTurn('completed');
  const all = order.map((id) => items.get(id)).filter((i): i is ChatItem => i !== undefined);
  // Tools from the old run that never finished will not finish now.
  for (const item of all) if (item.kind === 'tool' && item.status === 'running') item.status = 'error';
  return all.length > maxItems ? all.slice(all.length - maxItems) : all;
}

/** agentId -> the tool_use id whose result names it (`toolUseResult.agentId` of an Agent/Task call). */
function agentToolIds(entries: Rec[], into: Map<string, string>): void {
  for (const e of entries) {
    const agentId = str(rec(e.toolUseResult).agentId);
    if (e.type !== 'user' || !agentId || into.has(agentId)) continue;
    const block = arr(rec(e.message).content)
      .map(rec)
      .find((b) => b.type === 'tool_result');
    const toolUseId = str(block?.tool_use_id);
    if (toolUseId) into.set(agentId, toolUseId);
  }
}

/**
 * Replays the tool calls of the session's sub-agents (see the header) under
 * their Agent/Task card, the way the live stream nests them through
 * `parent_tool_use_id`. Only agents whose starting call is in the replayed
 * conversation are shown; a sub-agent's own sub-agents follow their parent.
 */
async function replaySubagents(file: string, chain: Rec[], mapper: ClaudeMapper): Promise<void> {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // no sub-agents
  }
  const ids = names
    .map((n) => /^agent-([\w-]+)\.jsonl$/.exec(n)?.[1])
    .filter((id): id is string => id !== undefined);
  const agents = await mapPool(ids, 8, async (id) => {
    let toolUseId: string | undefined;
    try {
      toolUseId = str(
        rec(JSON.parse(await readFile(path.join(dir, `agent-${id}.meta.json`), 'utf8'))).toolUseId,
      );
    } catch {
      // no meta file: fall back to the agentId in the starting call's result
    }
    try {
      const entries = parseLines(await readFile(path.join(dir, `agent-${id}.jsonl`), 'utf8'), false, false);
      return { id, toolUseId, entries };
    } catch {
      return undefined;
    }
  });
  const loaded = agents.filter((a): a is NonNullable<typeof a> => a !== undefined);
  const byResult = new Map<string, string>();
  agentToolIds(chain, byResult);
  for (const a of loaded) agentToolIds(a.entries, byResult);
  let left: Array<{ parent: string; entries: Rec[] }> = [];
  for (const a of loaded) {
    const parent = a.toolUseId ?? byResult.get(a.id);
    if (parent !== undefined) left.push({ parent, entries: a.entries });
  }
  // Parents first: a nested agent's starting call is in its parent agent's transcript.
  for (;;) {
    const ready = left.filter((a) => mapper.tools.has(a.parent));
    if (ready.length === 0) return;
    for (const a of ready) {
      for (const e of a.entries) {
        if (e.type === 'assistant') mapper.onAssistant({ ...e, parentToolUseID: a.parent });
        else if (e.type === 'user' && arr(rec(e.message).content).some((b) => rec(b).type === 'tool_result'))
          mapper.onToolResults(e);
      }
    }
    left = left.filter((a) => !ready.includes(a));
  }
}
