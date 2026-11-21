import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import type { ChatItem, ToolDetail, ToolItem } from '@phone-code/protocol';
import { ansiToHtml } from '../../lib/ansi';
import { childrenOf, type ChatState } from '../../lib/state';
import { Icon, Spinner, type IconName } from '../../ui/icons';
import { Markdown } from './md';

// ------------------------------------------------------------ naming

function toolIcon(name: string): IconName {
  switch (name) {
    case 'Bash':
      return 'terminal';
    case 'Read':
      return 'doc';
    case 'Write':
      return 'addSquare';
    case 'Edit':
      return 'pencil';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'globe';
    case 'Todo':
      return 'list';
    case 'Task':
      return 'sparkle';
    default:
      return 'code';
  }
}

function verb(t: ToolItem): string {
  const running = t.status === 'running';
  switch (t.name) {
    case 'Bash':
      return running ? 'Running' : 'Ran';
    case 'Read':
      return running ? 'Reading' : 'Read';
    case 'Write':
      return running ? 'Writing' : 'Wrote';
    case 'Edit':
      return running ? 'Editing' : 'Edited';
    case 'Glob':
      return running ? 'Finding' : 'Found';
    case 'Grep':
      return running ? 'Searching' : 'Searched';
    case 'WebFetch':
      return running ? 'Fetching' : 'Fetched';
    case 'WebSearch':
      return running ? 'Searching the web' : 'Searched the web';
    case 'Todo':
      return 'Updated plan';
    case 'Task':
      return 'Agent';
    default:
      return t.name.replace(/^mcp__/, '').replace(/__/g, ' · ');
  }
}

/** "Ran 3 commands, edited 2 files" */
export function summarize(tools: ToolItem[]): string {
  const n: Record<string, number> = {};
  for (const t of tools) {
    const k =
      t.name === 'Bash'
        ? 'cmd'
        : t.name === 'Edit' || t.name === 'Write'
          ? 'edit'
          : t.name === 'Read'
            ? 'read'
            : t.name === 'Grep' || t.name === 'Glob' || t.name === 'WebSearch'
              ? 'search'
              : t.name === 'WebFetch'
                ? 'fetch'
                : 'other';
    n[k] = (n[k] ?? 0) + 1;
  }
  const plural = (c: number, one: string, many: string): string => `${c} ${c === 1 ? one : many}`;
  const parts: string[] = [];
  if (n.cmd) parts.push(`ran ${plural(n.cmd, 'command', 'commands')}`);
  if (n.edit) parts.push(`edited ${plural(n.edit, 'file', 'files')}`);
  if (n.read) parts.push(`read ${plural(n.read, 'file', 'files')}`);
  if (n.search) parts.push(`${plural(n.search, 'search', 'searches')}`);
  if (n.fetch) parts.push(`fetched ${plural(n.fetch, 'page', 'pages')}`);
  if (n.other) parts.push(`${plural(n.other, 'other step', 'other steps')}`);
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------ details

function Output({ text, truncated, ansi = true }: { text: string; truncated?: boolean; ansi?: boolean }): JSX.Element {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > 24;
  const shown = long && !all ? lines.slice(0, 24).join('\n') : text;
  const html = useMemo(() => (ansi ? ansiToHtml(shown) : null), [shown, ansi]);
  return (
    <div class="tool-output">
      {html !== null ? <pre dangerouslySetInnerHTML={{ __html: html }} /> : <pre>{shown}</pre>}
      {long && !all && (
        <button type="button" class="tool-more" onClick={() => setAll(true)}>
          Show {lines.length - 24} more lines
        </button>
      )}
      {truncated && (all || !long) && <div class="tool-note">Output truncated by the host</div>}
    </div>
  );
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  a?: number;
  b?: number;
}

function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (m) {
      a = Number(m[1]);
      b = Number(m[2]);
      out.push({ kind: 'hunk', text: (m[3] ?? '').trim() });
      continue;
    }
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') out.push({ kind: 'add', text, b: b++ });
    else if (sign === '-') out.push({ kind: 'del', text, a: a++ });
    else if (sign === '\\') continue;
    else out.push({ kind: 'ctx', text, a: a++, b: b++ });
  }
  return out;
}

export function DiffView({ patch, max = 60 }: { patch: string; max?: number }): JSX.Element {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, max);
  return (
    <div class="diff" data-testid="diff-view">
      <div class="diff-scroll">
        <table>
          <tbody>
            {shown.map((l, i) =>
              l.kind === 'hunk' ? (
                <tr key={i} class="d-hunk">
                  <td class="d-n" colSpan={2} />
                  <td class="d-t">{l.text || '⋯'}</td>
                </tr>
              ) : (
                <tr key={i} class={`d-${l.kind}`}>
                  <td class="d-n">{l.kind === 'add' ? '' : l.a}</td>
                  <td class="d-n">{l.kind === 'del' ? '' : l.b}</td>
                  <td class="d-t">
                    <span class="d-s">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                    {l.text}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {lines.length > max && !all && (
        <button type="button" class="tool-more" onClick={() => setAll(true)}>
          Show {lines.length - max} more lines
        </button>
      )}
    </div>
  );
}

export function CommandBox({ command, cwd }: { command: string; cwd?: string }): JSX.Element {
  return (
    <div class="cmd-box">
      {cwd && <div class="cmd-cwd">{cwd}</div>}
      <code>
        <span class="cmd-prompt">$</span>
        {command}
      </code>
    </div>
  );
}

export function DetailView({ detail }: { detail: ToolDetail }): JSX.Element {
  switch (detail.type) {
    case 'command':
      return <CommandBox command={detail.command} cwd={detail.cwd} />;
    case 'diff':
      return <DiffView patch={detail.patch} />;
    case 'file':
      return detail.content ? (
        <div class="tool-output">
          <pre>{detail.content}</pre>
        </div>
      ) : (
        <div class="tool-kv">
          <span>File</span>
          <code>{detail.path}</code>
        </div>
      );
    case 'todos':
      return <TodoList todos={detail.todos} />;
    case 'search':
      return (
        <div class="tool-kv">
          <span>Query</span>
          <code>{detail.query}</code>
          {detail.path && (
            <>
              <span>In</span>
              <code>{detail.path}</code>
            </>
          )}
        </div>
      );
    case 'url':
      return (
        <div class="tool-kv">
          <span>URL</span>
          <a href={detail.url} target="_blank" rel="noopener noreferrer">
            {detail.url}
          </a>
        </div>
      );
    default: {
      const never: never = detail;
      return never;
    }
  }
}

function TodoList({ todos }: { todos: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> }): JSX.Element {
  return (
    <ul class="todos" data-testid="todo-list">
      {todos.map((t, i) => (
        <li key={i} class={`todo-${t.status}`}>
          <span class="todo-box" aria-hidden="true">
            {t.status === 'completed' && <Icon name="check" size={13} stroke={3} />}
            {t.status === 'in_progress' && <span class="todo-dot" />}
          </span>
          <span class="todo-text">{t.text}</span>
          <span class="sr-only">{t.status.replace('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

function Json({ value }: { value: unknown }): JSX.Element {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div class="tool-output">
      <pre>{text}</pre>
    </div>
  );
}

// ------------------------------------------------------------ rows

function StatusMark({ t }: { t: ToolItem }): JSX.Element | null {
  if (t.status === 'running') return <Spinner size={15} />;
  if (t.status === 'error')
    return (
      <span class="tool-status bad" aria-label="Failed">
        <Icon name="close" size={13} stroke={2.6} />
      </span>
    );
  if (t.status === 'denied')
    return (
      <span class="tool-status bad" aria-label="Denied">
        Denied
      </span>
    );
  return null;
}

function Meta({ t }: { t: ToolItem }): JSX.Element | null {
  const d = t.detail;
  if (d?.type === 'diff')
    return (
      <span class="diff-counts">
        <span class="plus">+{d.added}</span>
        <span class="minus">−{d.removed}</span>
      </span>
    );
  if (d?.type === 'command' && d.exitCode !== undefined && d.exitCode !== 0)
    return <span class="exit-chip">exit {d.exitCode}</span>;
  return null;
}

export function ToolRow({ item, nested }: { item: Signal<ChatItem>; nested?: boolean }): JSX.Element | null {
  const t = item.value;
  const [open, setOpen] = useState(false);
  if (t.kind !== 'tool') return null;
  const hasBody = !!(t.detail || t.output || t.input !== undefined);
  return (
    <div
      class={`tool-row ${open ? 'open' : ''} st-${t.status} ${nested ? 'nested' : ''}`}
      data-testid="chat-item-tool"
      data-tool={t.name}
      data-status={t.status}
    >
      <button
        type="button"
        class="tool-head"
        aria-expanded={open}
        disabled={!hasBody}
        onClick={() => setOpen(!open)}
      >
        <span class={`tool-icon ti-${t.name.toLowerCase()}`}>
          <Icon name={toolIcon(t.name)} size={15} stroke={2.1} />
        </span>
        <span class="tool-label">
          <span class="tool-verb">{verb(t)}</span>
          <span class="tool-title">{t.title}</span>
        </span>
        <Meta t={t} />
        <StatusMark t={t} />
        {hasBody && <Icon name="forward" size={14} stroke={2.4} class="tool-chev" />}
      </button>
      {open && (
        <div class="tool-body">
          {t.detail && t.detail.type !== 'command' && <DetailView detail={t.detail} />}
          {t.detail?.type === 'command' && <CommandBox command={t.detail.command} cwd={t.detail.cwd} />}
          {t.output !== undefined && t.output !== '' && (t.detail?.type !== 'diff' || t.status === 'error') && (
            <Output text={t.output} truncated={t.outputTruncated} />
          )}
          {t.output === '' && t.status === 'done' && t.name === 'Bash' && <div class="tool-note">No output</div>}
          {!t.detail && t.output === undefined && t.input !== undefined && <Json value={t.input} />}
          {!t.detail && t.output !== undefined && t.input !== undefined && (
            <details class="tool-input">
              <summary>Input</summary>
              <Json value={t.input} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** Consecutive tool calls share one card; long runs collapse to a summary. */
export function ToolGroup({ chat, ids }: { chat: ChatState; ids: string[] }): JSX.Element {
  const items = ids.map((id) => chat.items.get(id)).filter((x): x is Signal<ChatItem> => !!x);
  const tools = items.map((s) => s.value).filter((x): x is ToolItem => x.kind === 'tool');
  const running = tools.some((t) => t.status === 'running');
  const collapsible = items.length >= 4;
  const [expanded, setExpanded] = useState(false);
  const visible = collapsible && !expanded ? items.slice(-2) : items;
  return (
    <div class="tool-group" data-testid="tool-group">
      {collapsible && (
        <button
          type="button"
          class="tool-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span class="tool-stack" aria-hidden="true">
            {tools.slice(0, 3).map((t) => (
              <span key={t.id} class={`tool-icon ti-${t.name.toLowerCase()}`}>
                <Icon name={toolIcon(t.name)} size={13} stroke={2.2} />
              </span>
            ))}
          </span>
          <span class="tool-summary-text">{summarize(tools)}</span>
          {running && <Spinner size={14} />}
          <Icon name={expanded ? 'up' : 'down'} size={14} stroke={2.4} class="tool-chev" />
        </button>
      )}
      {visible.map((s) => (
        <ToolRow key={s.value.id} item={s} />
      ))}
    </div>
  );
}

/** Todo list as its own card, always visible. */
export function TodoCard({ item }: { item: Signal<ChatItem> }): JSX.Element | null {
  const t = item.value;
  if (t.kind !== 'tool' || t.detail?.type !== 'todos') return null;
  const todos = t.detail.todos;
  const done = todos.filter((x) => x.status === 'completed').length;
  return (
    <div class="todo-card" data-testid="chat-item-todo">
      <div class="todo-head">
        <Icon name="list" size={16} stroke={2.1} />
        <span>Plan</span>
        <span class="todo-progress">
          {done} of {todos.length}
        </span>
        <span class="todo-bar" style={{ '--p': String(todos.length ? done / todos.length : 0) }} />
      </div>
      <TodoList todos={todos} />
    </div>
  );
}

/** Sub-agent: a card with its nested calls and final report. */
export function TaskCard({ chat, item }: { chat: ChatState; item: Signal<ChatItem> }): JSX.Element | null {
  const t = item.value;
  const kids = childrenOf(chat, t.id).value;
  const [open, setOpen] = useState(false);
  if (t.kind !== 'tool') return null;
  const prompt =
    t.input && typeof t.input === 'object' && 'prompt' in t.input ? String((t.input as { prompt: unknown }).prompt) : '';
  return (
    <div class={`task-card st-${t.status}`} data-testid="chat-item-task" data-status={t.status}>
      <button type="button" class="task-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="tool-icon ti-task">
          <Icon name="sparkle" size={15} stroke={2.1} />
        </span>
        <span class="tool-label">
          <span class="tool-verb">Agent</span>
          <span class="task-title">{t.title}</span>
        </span>
        <span class="task-count">{kids.length} steps</span>
        <StatusMark t={t} />
        <Icon name={open ? 'up' : 'down'} size={14} stroke={2.4} class="tool-chev" />
      </button>
      {open && prompt && <div class="task-prompt">{prompt}</div>}
      {kids.length > 0 && (
        <div class="task-children">
          {(open ? kids : kids.slice(-3)).map((id) => {
            const s = chat.items.get(id);
            return s ? <ToolRow key={id} item={s} nested /> : null;
          })}
          {!open && kids.length > 3 && (
            <button type="button" class="task-more" onClick={() => setOpen(true)}>
              {kids.length - 3} earlier steps
            </button>
          )}
        </div>
      )}
      {t.output && t.status !== 'running' && (
        <div class="task-result">
          <Markdown text={t.output} />
        </div>
      )}
    </div>
  );
}
