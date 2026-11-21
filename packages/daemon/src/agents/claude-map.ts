/**
 * Turns Claude Code messages (live stream-json frames or session-JSONL
 * entries, which share the same message shapes) into ChatItems.
 *
 * Item ids:
 *   text / thinking  `${apiMessageId}:${blockIndex}` (same live and on resume)
 *   tool             the tool_use id
 *   plan text        `plan:${toolUseId}`
 */
import type { ChatItem, TextItem, ThinkingItem, ToolItem, ToolStatus } from '@phone-code/protocol';
import type { AgentEvents } from './types.ts';
import { arr, isRec, num, rec, str, truncateOutput, type Rec } from './shared/common.ts';
import {
  HIDDEN_TOOLS,
  bashExitCode,
  describeTool,
  fileDiff,
  refineFileDetail,
  toolResultText,
} from './claude-tools.ts';

type Sink = Pick<AgentEvents, 'upsert' | 'delta'>;

interface StreamBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'other';
  itemId: string;
  text: string;
  shown: boolean;
  done: boolean;
}

const DENIAL_PREFIXES = [
  "The user doesn't want to proceed",
  'User denied',
  'Permission denied by user',
  'Error: User denied',
];

export class ClaudeMapper {
  readonly tools = new Map<string, ToolItem>();
  /** Raw (un-normalized) tool name per tool id. */
  readonly rawNames = new Map<string, string>();
  private readonly texts = new Map<string, TextItem | ThinkingItem>();
  private readonly blocks = new Map<string, StreamBlock>();
  private readonly blockCount = new Map<string, number>();
  private currentMsg: string | undefined;
  private turnTools = new Set<string>();
  /** Tool ids the user denied through us. */
  readonly denied = new Set<string>();
  /** Called after a tool item's detail was refined (so pending permissions can follow). */
  onToolRefined: ((toolId: string) => void) | undefined;

  constructor(
    private readonly sink: Sink,
    private readonly cwd: string,
    private readonly live: boolean,
  ) {}

  private upsert(item: ChatItem): void {
    if (item.kind === 'tool') this.tools.set(item.id, item);
    else if (item.kind === 'text' || item.kind === 'thinking') this.texts.set(item.id, item);
    this.sink.upsert(item);
  }

  beginTurn(): void {
    this.turnTools = new Set();
  }

  // ------------------------------------------------------------ streaming

  onStreamEvent(evValue: unknown, parentToolUseId: string | null): void {
    if (parentToolUseId) return; // sub-agent tokens: their tool calls arrive as full messages
    const ev = rec(evValue);
    switch (ev.type) {
      case 'message_start':
        this.currentMsg = str(rec(ev.message).id) ?? this.currentMsg;
        return;
      case 'content_block_start': {
        const msg = this.currentMsg;
        const index = num(ev.index);
        if (!msg || index === undefined) return;
        const cb = rec(ev.content_block);
        const itemId = `${msg}:${index}`;
        const type = str(cb.type);
        if (type === 'text') {
          const text = str(cb.text) ?? '';
          this.blocks.set(itemId, { kind: 'text', itemId, text, shown: true, done: false });
          this.upsert({ kind: 'text', id: itemId, ts: Date.now(), text, streaming: true });
        } else if (type === 'thinking') {
          const text = str(cb.thinking) ?? '';
          const shown = text.length > 0;
          this.blocks.set(itemId, { kind: 'thinking', itemId, text, shown, done: false });
          if (shown) this.upsert({ kind: 'thinking', id: itemId, ts: Date.now(), text, streaming: true });
        } else if (type === 'tool_use' || type === 'server_tool_use') {
          const id = str(cb.id);
          const name = str(cb.name) ?? 'tool';
          this.blocks.set(itemId, {
            kind: 'tool_use',
            itemId: id ?? itemId,
            text: '',
            shown: false,
            done: false,
          });
          if (id && !HIDDEN_TOOLS.has(name) && !this.tools.has(id)) {
            const view = describeTool(name === 'web_search' ? 'WebSearch' : name, {}, this.cwd);
            this.rawNames.set(id, name);
            this.turnTools.add(id);
            this.upsert({
              kind: 'tool',
              id,
              ts: Date.now(),
              name: view.name,
              title: view.name,
              status: 'running',
            });
          }
        } else {
          this.blocks.set(itemId, { kind: 'other', itemId, text: '', shown: false, done: false });
        }
        return;
      }
      case 'content_block_delta': {
        const msg = this.currentMsg;
        const index = num(ev.index);
        if (!msg || index === undefined) return;
        const block = this.blocks.get(`${msg}:${index}`);
        if (!block || block.done) return;
        const d = rec(ev.delta);
        const piece =
          d.type === 'text_delta' ? str(d.text) : d.type === 'thinking_delta' ? str(d.thinking) : undefined;
        if (!piece) return;
        block.text += piece;
        if (block.kind === 'thinking' && !block.shown) {
          block.shown = true;
          this.upsert({
            kind: 'thinking',
            id: block.itemId,
            ts: Date.now(),
            text: block.text,
            streaming: true,
          });
        } else if (block.kind === 'text' || block.kind === 'thinking') {
          const item = this.texts.get(block.itemId);
          if (item) item.text = block.text;
          this.sink.delta(block.itemId, piece);
        }
        return;
      }
      case 'content_block_stop': {
        const msg = this.currentMsg;
        const index = num(ev.index);
        if (!msg || index === undefined) return;
        const block = this.blocks.get(`${msg}:${index}`);
        if (block) this.finishBlock(block);
        return;
      }
      default:
        return;
    }
  }

  private finishBlock(block: StreamBlock): void {
    if (block.done) return;
    block.done = true;
    if ((block.kind === 'text' || block.kind === 'thinking') && block.shown) {
      const prev = this.texts.get(block.itemId);
      this.upsert({
        kind: block.kind,
        id: block.itemId,
        ts: prev?.ts ?? Date.now(),
        text: block.text,
        streaming: false,
      });
    }
  }

  /** Close every still-streaming block (turn ended, interrupted, crashed). */
  closeStreams(): void {
    for (const block of this.blocks.values()) this.finishBlock(block);
    this.blocks.clear();
  }

  // ------------------------------------------------------- full messages

  onAssistant(entry: Rec): void {
    const message = rec(entry.message);
    const msgId = str(message.id) ?? str(entry.uuid) ?? `m${Date.now()}`;
    const parent = str(entry.parent_tool_use_id) ?? str(entry.parentToolUseID) ?? null;
    const ts = tsOf(entry);
    const content = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : [];
    for (const blockValue of content) {
      const n = this.blockCount.get(msgId) ?? 0;
      this.blockCount.set(msgId, n + 1);
      const block = rec(blockValue);
      const itemId = `${msgId}:${n}`;
      const streamed = this.blocks.get(itemId);
      switch (block.type) {
        case 'text': {
          if (parent) break; // sub-agent prose stays inside the Task card
          const text = str(block.text) ?? '';
          if (streamed) streamed.done = true;
          if (!text && !streamed?.shown) break;
          this.upsert({
            kind: 'text',
            id: itemId,
            ts: this.texts.get(itemId)?.ts ?? ts,
            text,
            streaming: false,
          });
          break;
        }
        case 'thinking': {
          if (parent) break;
          const finalText = str(block.thinking) ?? '';
          const text = finalText || streamed?.text || '';
          if (streamed) streamed.done = true;
          if (!text) break;
          this.upsert({
            kind: 'thinking',
            id: itemId,
            ts: this.texts.get(itemId)?.ts ?? ts,
            text,
            streaming: false,
          });
          break;
        }
        case 'tool_use':
        case 'server_tool_use':
          if (streamed) streamed.done = true;
          this.onToolUse(block, parent, ts);
          break;
        case 'web_search_tool_result': {
          const id = str(block.tool_use_id);
          const tool = id ? this.tools.get(id) : undefined;
          if (tool) {
            const results = arr(block.content).map((r) =>
              `${str(rec(r).title) ?? ''} ${str(rec(r).url) ?? ''}`.trim(),
            );
            this.upsert({ ...tool, status: 'done', output: results.join('\n') });
          }
          break;
        }
        default:
          break; // redacted_thinking and future block types
      }
    }
  }

  private onToolUse(block: Rec, parent: string | null, ts: number): void {
    const id = str(block.id);
    const raw = str(block.name) ?? 'tool';
    if (!id) return;
    const rawName = raw === 'web_search' ? 'WebSearch' : raw === 'web_fetch' ? 'WebFetch' : raw;
    const input = block.input;
    if (rawName === 'ExitPlanMode') {
      const plan = str(rec(input).plan);
      if (plan && !parent)
        this.upsert({ kind: 'text', id: `plan:${id}`, ts, text: `**Plan**\n\n${plan}`, streaming: false });
      return;
    }
    if (HIDDEN_TOOLS.has(rawName)) return;
    this.rawNames.set(id, rawName);
    this.turnTools.add(id);
    const view = describeTool(rawName, input, this.cwd);
    const prev = this.tools.get(id);
    const item: ToolItem = {
      kind: 'tool',
      id,
      ts: prev?.ts ?? ts,
      name: view.name,
      title: view.title,
      status: prev && prev.status !== 'running' ? prev.status : 'running',
      input,
      ...(view.detail ? { detail: view.detail } : {}),
      ...(parent ? { parentId: parent } : {}),
      ...(prev?.output !== undefined ? { output: prev.output, outputTruncated: prev.outputTruncated } : {}),
    };
    this.upsert(item);
    if (this.live) void this.refine(id, rawName, input);
  }

  /** Re-diff against the file on disk so the card shows real line numbers and context. */
  private async refine(id: string, rawName: string, input: unknown): Promise<void> {
    let detail;
    try {
      detail = await refineFileDetail(rawName, input, this.cwd);
    } catch {
      return;
    }
    const cur = this.tools.get(id);
    // Only while the tool has not run yet: afterwards the file already holds the new content.
    if (!detail || !cur || cur.status !== 'running') return;
    if (JSON.stringify(detail) === JSON.stringify(cur.detail)) return;
    this.upsert({ ...cur, detail });
    this.onToolRefined?.(id);
  }

  /**
   * A user-role message: tool results (live and history). `toolUseResult` is
   * the structured result (live: `tool_use_result`, JSONL: `toolUseResult`).
   */
  onToolResults(entry: Rec): void {
    const message = rec(entry.message);
    const structured = entry.tool_use_result ?? entry.toolUseResult;
    const metas = arr(entry.tool_result_meta);
    for (const blockValue of arr(message.content)) {
      const block = rec(blockValue);
      if (block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      const tool = this.tools.get(id);
      if (!tool) continue;
      const rawName = this.rawNames.get(id) ?? tool.name;
      const text = toolResultText(block.content);
      const isError = block.is_error === true;
      const meta = rec(metas.find((m) => rec(m).id === id));
      // live: tool_result_meta[].permission_decision; JSONL: permissionDecision / toolDenialKind
      const rejected =
        rec(meta.permission_decision).decision === 'reject' ||
        rec(entry.permissionDecision).decision === 'reject' ||
        typeof entry.toolDenialKind === 'string';
      let status: ToolStatus = 'done';
      if (isError) {
        status =
          rejected || this.denied.has(id) || DENIAL_PREFIXES.some((p) => text.startsWith(p))
            ? 'denied'
            : 'error';
      }
      let outputText = text;
      let detail = tool.detail;
      const s = rec(structured);
      if ((rawName === 'Bash' || rawName === 'PowerShell') && isRec(structured)) {
        const stdout = str(s.stdout) ?? '';
        const stderr = str(s.stderr) ?? '';
        if (!isError && (stdout || stderr))
          outputText = stderr ? `${stdout}${stdout ? '\n' : ''}${stderr}` : stdout;
        if (detail?.type === 'command') {
          const exitCode = bashExitCode(text, isError);
          detail = { ...detail, ...(exitCode !== undefined ? { exitCode } : {}) };
        }
      } else if (detail?.type === 'command') {
        const exitCode = bashExitCode(text, isError);
        if (exitCode !== undefined) detail = { ...detail, exitCode };
      }
      if (
        ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(rawName) &&
        isRec(structured) &&
        'originalFile' in s
      ) {
        const orig = s.originalFile;
        const original = typeof orig === 'string' ? orig : s.type === 'create' ? null : undefined;
        const d = fileDiff(rawName, rec(tool.input), this.cwd, original);
        if (d) detail = d;
      }
      const { output, truncated } = truncateOutput(outputText);
      this.upsert({
        ...tool,
        status,
        output,
        ...(truncated ? { outputTruncated: true } : { outputTruncated: undefined }),
        ...(detail ? { detail } : {}),
      });
    }
  }

  /** End of turn: close streams; tools that never got a result failed unless the turn completed. */
  endTurn(outcome: 'completed' | 'interrupted' | 'error'): void {
    this.closeStreams();
    if (outcome === 'completed') return;
    for (const id of this.turnTools) {
      const tool = this.tools.get(id);
      if (tool?.status === 'running') {
        const input = rec(tool.input);
        if (input.run_in_background === true) continue;
        this.upsert({
          ...tool,
          status: 'error',
          output: tool.output ?? (outcome === 'interrupted' ? 'Interrupted' : 'Failed'),
        });
      }
    }
  }
}

export function tsOf(entry: Rec): number {
  const t = str(entry.timestamp);
  if (t) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}
