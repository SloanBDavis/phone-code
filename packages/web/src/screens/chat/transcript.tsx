import type { JSX, RefObject } from 'preact';
import type { Signal } from '@preact/signals';
import type { ChatItem } from '@phone-code/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatState } from '../../lib/state';
import { duration } from '../../lib/util';
import { Icon, Spinner } from '../../ui/icons';
import { PermissionCard, QuestionCard } from './asks';
import { DocumentCard } from './documents';
import { NoticeRow, PendingBubble, TextBlock, ThinkingBlock, TurnFooter, UserBubble } from './items';
import { TaskCard, TodoCard, ToolGroup, activityOf } from './tools';

type Block =
  | { k: 'one'; id: string }
  | { k: 'tools'; ids: string[] }
  /** What the agent did on the way to its answer, folded into one line. */
  | { k: 'work'; ids: string[]; live: boolean; turnId?: string };

/** A turn's steps fold into one line from this many on; fewer are shown as they are. */
const FOLD_FROM = 3;

/** Consecutive tool calls share one group; everything else is a block of its own. */
function grouped(chat: ChatState, ids: string[]): Block[] {
  const out: Block[] = [];
  let run: string[] | null = null;
  for (const id of ids) {
    const item = chat.items.get(id)?.peek();
    const groupable =
      item?.kind === 'tool' && item.name !== 'Todo' && item.name !== 'Task' && item.name !== 'Document';
    if (groupable) {
      if (!run) {
        run = [];
        out.push({ k: 'tools', ids: run });
      }
      run.push(id);
    } else {
      run = null;
      out.push({ k: 'one', id });
    }
  }
  return out;
}

/**
 * The transcript as blocks. A turn is what follows a message of the user's up
 * to the turn's end: its answer is the text it ends with, and everything
 * before that (thinking, tool calls, what the agent said along the way) is
 * the work, folded into one line that opens. Something waiting for the user
 * (an approval, a question), warnings, the current plan and the documents the
 * agent wrote (the latest version of each) stay in view.
 */
function blocksOf(chat: ChatState, ids: string[], asks: string[], running: boolean): Block[] {
  const out: Block[] = [];
  let body: string[] = [];
  const flush = (turnId: string | undefined, last: boolean): void => {
    if (body.length === 0) return;
    const kindOf = (id: string): ChatItem['kind'] | undefined => chat.kinds.get(id);
    let end = body.length;
    while (end > 0 && kindOf(body[end - 1] ?? '') === 'text') end--;
    const answer = body.slice(end);
    const work: string[] = [];
    const inView: string[] = [];
    const before = body.slice(0, end);
    // The plan as it stands now: the turn's latest list of to-dos.
    const plan = before.findLast((id) => {
      const item = chat.items.get(id)?.peek();
      return item?.kind === 'tool' && item.name === 'Todo';
    });
    // Each document the agent wrote, as last written in this turn.
    const docs = new Map<string, string>();
    for (const id of before) {
      const item = chat.items.get(id)?.peek();
      if (item?.kind === 'tool' && item.detail?.type === 'document') docs.set(item.detail.path, id);
    }
    const latestDocs = new Set(docs.values());
    for (const id of before) {
      const item = chat.items.get(id)?.peek();
      const stays =
        id === plan ||
        latestDocs.has(id) ||
        asks.includes(id) ||
        (item?.kind === 'notice' && item.level !== 'info');
      (stays ? inView : work).push(id);
    }
    const live = turnId === undefined && last && running;
    if (work.length >= FOLD_FROM) out.push({ k: 'work', ids: work, live, ...(turnId ? { turnId } : {}) });
    else out.push(...grouped(chat, work));
    out.push(...grouped(chat, inView), ...grouped(chat, answer));
    body = [];
  };
  for (const id of ids) {
    const kind = chat.kinds.get(id);
    if (kind === 'user') {
      flush(undefined, false);
      out.push({ k: 'one', id });
    } else if (kind === 'turn') {
      flush(id, false);
      out.push({ k: 'one', id });
    } else body.push(id);
  }
  flush(undefined, true);
  return out;
}

const keyOf = (b: Block): string => (b.k === 'one' ? b.id : `${b.k}:${b.ids[0] ?? ''}`);

const PAGE = 60;
const STICK_PX = 72;
const JUMP_PX = 240;

export interface ScrollApi {
  toBottom(smooth?: boolean): void;
}

/**
 * The transcript. Only the newest PAGE blocks are mounted (more are added as
 * the user scrolls up, keeping their reading position), each block opts into
 * `content-visibility: auto`, and every item subscribes to its own signal, so
 * streaming touches one node. Autoscroll follows new contentRef only while the
 * reader is at the bottom and not touchingRef the screen.
 */
export function Transcript({
  chat,
  sessionId,
  agent,
  apiRef,
  scrollRef,
  jump,
  running,
}: {
  chat: ChatState;
  sessionId: string;
  agent: string;
  apiRef: RefObject<ScrollApi | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Whether the reader is away from the bottom (the button that goes back there shows). */
  jump: Signal<boolean>;
  /** Whether the agent is at work on a turn. */
  running: boolean;
}): JSX.Element {
  const ids = chat.ids.value;
  const asks = chat.asks.value;
  const all = useMemo(() => blocksOf(chat, ids, asks, running), [chat, ids, asks, running]);
  const countRef = useRef(all.length);
  countRef.current = all.length;
  const [limit, setLimit] = useState(PAGE);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const touchingRef = useRef(false);
  const setShowJump = (v: boolean): void => {
    if (jump.peek() !== v) jump.value = v;
  };
  const anchorRef = useRef<{ h: number; top: number } | null>(null);

  const hidden = Math.max(0, all.length - limit);
  const shown = hidden ? all.slice(hidden) : all;
  const pending = chat.pending.value;

  const toBottom = (smooth = false): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  apiRef.current = { toBottom };

  // Follow contentRef growth while stuck to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner) return undefined;
    let last = inner.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      const grew = h > last;
      last = h;
      if (stickRef.current && !touchingRef.current) el.scrollTop = el.scrollHeight;
      else if (grew) setShowJump(true);
    });
    ro.observe(inner);
    ro.observe(el); // keyboard / composer height changes
    let frame = 0;
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickRef.current = dist < STICK_PX;
        // Away from the bottom by more than a glance: the way back is one click.
        setShowJump(dist > JUMP_PX);
        if (el.scrollTop < 600) setLimit((l) => (l < countRef.current ? growFrom(el, l) : l));
      });
    };
    const growFrom = (sc: HTMLElement, l: number): number => {
      anchorRef.current = { h: sc.scrollHeight, top: sc.scrollTop };
      return l + PAGE;
    };
    const down = (): void => {
      touchingRef.current = true;
    };
    const up = (): void => {
      touchingRef.current = false;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setShowJump only writes a stable signal
  }, [scrollRef]);

  // Keep the reading position when older blocks are mounted above.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    anchorRef.current = null;
    el.scrollTop = a.top + (el.scrollHeight - a.h);
  }, [limit, scrollRef]);

  // Start at the bottom when the transcript first appears.
  const loaded = chat.loaded.value;
  useLayoutEffect(() => {
    if (loaded) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on first load
  }, [loaded]);

  return (
    <>
      <div class="transcript" ref={contentRef} data-testid="transcript">
        {hidden > 0 && (
          <div class="transcript-more">
            <Spinner size={16} />
          </div>
        )}
        {shown.map((b) => (
          <div class="block" key={keyOf(b)}>
            <BlockView b={b} chat={chat} sessionId={sessionId} agent={agent} />
          </div>
        ))}
        {pending.map((p) => (
          <div class="block" key={p.localId}>
            <PendingBubble p={p} sessionId={sessionId} />
          </div>
        ))}
        <Working chat={chat} running={running} folded={all.at(-1)?.k === 'work'} />
      </div>
    </>
  );
}

function BlockView({
  b,
  chat,
  sessionId,
  agent,
}: {
  b: Block;
  chat: ChatState;
  sessionId: string;
  agent: string;
}): JSX.Element {
  if (b.k === 'tools') return <ToolGroup chat={chat} ids={b.ids} />;
  if (b.k === 'work') return <Work b={b} chat={chat} sessionId={sessionId} agent={agent} />;
  return <Item chat={chat} id={b.id} sessionId={sessionId} agent={agent} />;
}

/** Milliseconds since `since` (0 without one), ticking each second while `on`. */
function useElapsed(since: number | undefined, on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const timer = window.setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return since === undefined ? 0 : Math.max(0, t - since);
}

/**
 * A turn's work in one line: what the agent is doing now while it runs
 * ("Reading app.ts · 12 steps · 1m 4s"), how much it did once it is done
 * ("Worked for 2m 10s · 14 steps"). A click opens every step. Sub-agents that
 * are still running stay in view under it.
 */
function Work({
  b,
  chat,
  sessionId,
  agent,
}: {
  b: Extract<Block, { k: 'work' }>;
  chat: ChatState;
  sessionId: string;
  agent: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const first = chat.items.get(b.ids[0] ?? '')?.peek();
  const lastSig = chat.items.get(b.ids.at(-1) ?? '');
  const last = lastSig?.value;
  const turn = b.turnId ? chat.items.get(b.turnId)?.value : undefined;
  const elapsed = useElapsed(first?.ts, b.live);
  const steps = b.ids.filter((id) => chat.kinds.get(id) === 'tool').length;
  const took =
    turn?.kind === 'turn' && turn.durationMs !== undefined
      ? turn.durationMs
      : Math.max(0, (last?.ts ?? 0) - (first?.ts ?? 0));
  const count = steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '';
  const agents = b.live
    ? b.ids.filter((id) => {
        const t = chat.items.get(id)?.value;
        return t?.kind === 'tool' && t.name === 'Task' && t.status === 'running';
      })
    : [];
  return (
    <div
      class={`work ${open ? 'open' : ''} ${b.live ? 'live' : ''}`}
      data-testid="chat-work"
      data-live={b.live}
    >
      <button
        type="button"
        class="work-head"
        aria-expanded={open}
        data-testid="work-toggle"
        onClick={() => setOpen(!open)}
      >
        {b.live ? <Spinner size={14} /> : <Icon name="check" size={14} stroke={2.4} />}
        <span class="work-label">
          {b.live
            ? (last && activityOf(last)) || 'Working'
            : took >= 1000
              ? `Worked for ${duration(took)}`
              : 'Worked'}
        </span>
        <span class="work-meta">{[count, b.live ? duration(elapsed) : ''].filter(Boolean).join(' · ')}</span>
        <Icon name={open ? 'up' : 'down'} size={13} stroke={2.5} class="work-chev" />
      </button>
      {open ? (
        <div class="work-body" data-testid="work-body">
          {grouped(chat, b.ids).map((x) => (
            <div class="block" key={keyOf(x)}>
              <BlockView b={x} chat={chat} sessionId={sessionId} agent={agent} />
            </div>
          ))}
        </div>
      ) : (
        agents.map((id) => {
          const sig = chat.items.get(id);
          return sig ? <TaskCard key={id} chat={chat} item={sig} /> : null;
        })
      )}
    </div>
  );
}

/**
 * Something is happening: shown from the moment a message is sent until the
 * agent's first words, and in any pause where nothing on screen is moving.
 */
function Working({
  chat,
  running,
  folded,
}: {
  chat: ChatState;
  running: boolean;
  /** The folded work line is the last thing in the transcript: it already says so. */
  folded: boolean;
}): JSX.Element | null {
  const sending = chat.pending.value.some((p) => p.status === 'sending');
  const ids = chat.ids.value;
  const last = chat.items.get(ids.at(-1) ?? '')?.value;
  if (!sending && !running) return null;
  if (!sending && folded) return null;
  const moving =
    ((last?.kind === 'text' || last?.kind === 'thinking') && last.streaming) ||
    (last?.kind === 'tool' && last.status === 'running') ||
    ((last?.kind === 'permission' || last?.kind === 'question') && last.status === 'pending');
  if (!sending && moving) return null;
  return (
    <output class="working" data-testid="working">
      <Spinner size={14} />
      <span class="working-label">Working…</span>
    </output>
  );
}

/** Whether `id` is the latest version of the document at `path` in the chat (earlier ones are rows). */
function isLatestDocument(chat: ChatState, id: string, path: string): boolean {
  const ids = chat.ids.peek();
  for (let i = ids.length - 1; i >= 0; i--) {
    const t = chat.items.get(ids[i] ?? '')?.peek();
    if (t?.kind === 'tool' && t.detail?.type === 'document' && t.detail.path === path) return t.id === id;
  }
  return true;
}

function Item({
  chat,
  id,
  sessionId,
  agent,
}: {
  chat: ChatState;
  id: string;
  sessionId: string;
  agent: string;
}): JSX.Element | null {
  const s = chat.items.get(id);
  if (!s) return null;
  // Read the kind without subscribing: it never changes for an id.
  const item = s.peek();
  switch (item.kind) {
    case 'user':
      return <UserBubble item={s} sessionId={sessionId} />;
    case 'text':
      return <TextBlock item={s} sessionId={sessionId} />;
    case 'thinking':
      return <ThinkingBlock item={s} />;
    case 'tool':
      return item.name === 'Task' ? (
        <TaskCard chat={chat} item={s} />
      ) : item.name === 'Todo' ? (
        <TodoCard item={s} />
      ) : item.detail?.type === 'document' && isLatestDocument(chat, id, item.detail.path) ? (
        <DocumentCard chat={chat} item={s} sessionId={sessionId} />
      ) : (
        <ToolGroup chat={chat} ids={[id]} />
      );
    case 'permission':
      return <PermissionCard sessionId={sessionId} item={s} agent={agent} />;
    case 'question':
      return <QuestionCard sessionId={sessionId} item={s} />;
    case 'notice':
      return <NoticeRow item={s} />;
    case 'turn':
      return <TurnFooter item={s} />;
    default: {
      const never: never = item;
      return never;
    }
  }
}
