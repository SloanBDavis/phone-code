import type { JSX, RefObject } from 'preact';
import { useComputed, type Signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatState } from '../../lib/state';
import { Spinner } from '../../ui/icons';
import { PermissionCard, QuestionCard } from './asks';
import { NoticeRow, PendingBubble, TextBlock, ThinkingBlock, TurnFooter, UserBubble } from './items';
import { TaskCard, TodoCard, ToolGroup } from './tools';

type Block = { k: 'one'; id: string } | { k: 'tools'; ids: string[] };

const PAGE = 120;
const STICK_PX = 72;

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
}: {
  chat: ChatState;
  sessionId: string;
  agent: string;
  apiRef: RefObject<ScrollApi | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Whether new contentRef arrived below while the reader is scrolled up. */
  jump: Signal<boolean>;
}): JSX.Element {
  const blocks = useComputed<Block[]>(() => {
    const out: Block[] = [];
    let run: string[] | null = null;
    for (const id of chat.ids.value) {
      const kind = chat.kinds.get(id);
      const item = chat.items.get(id)?.peek();
      const groupable =
        kind === 'tool' && item?.kind === 'tool' && item.name !== 'Todo' && item.name !== 'Task';
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
  });
  const [limit, setLimit] = useState(PAGE);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const touchingRef = useRef(false);
  const setShowJump = (v: boolean): void => {
    if (jump.peek() !== v) jump.value = v;
  };
  const anchorRef = useRef<{ h: number; top: number } | null>(null);

  const all = blocks.value;
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
    if (!el || !inner) return;
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
        if (stickRef.current) setShowJump(false);
        if (el.scrollTop < 600) setLimit((l) => (l < blocks.peek().length ? growFrom(el, l) : l));
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
  }, [scrollRef, blocks]);

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
        {shown.map((b) =>
          b.k === 'tools' ? (
            <div class="block" key={b.ids[0]}>
              <ToolGroup chat={chat} ids={b.ids} />
            </div>
          ) : (
            <div class="block" key={b.id}>
              <Item chat={chat} id={b.id} sessionId={sessionId} agent={agent} />
            </div>
          ),
        )}
        {pending.map((p) => (
          <div class="block" key={p.localId}>
            <PendingBubble p={p} sessionId={sessionId} />
          </div>
        ))}
      </div>
    </>
  );
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
      return <UserBubble item={s} />;
    case 'text':
      return <TextBlock item={s} />;
    case 'thinking':
      return <ThinkingBlock item={s} />;
    case 'tool':
      return item.name === 'Task' ? (
        <TaskCard chat={chat} item={s} />
      ) : item.name === 'Todo' ? (
        <TodoCard item={s} />
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
