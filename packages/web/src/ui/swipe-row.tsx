import type { ComponentChildren, JSX } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { haptic } from '../lib/util';
import { Icon, type IconName } from './icons';

export interface SwipeAction {
  label: string;
  icon: IconName;
  tone: 'danger' | 'neutral' | 'accent';
  onAction: () => void;
  testid?: string;
}

/** Only one row is open at a time, like Mail. */
const openRow = signal<string | null>(null);

const ACTION_W = 76;

/**
 * A list row that reveals actions when swiped left. Vertical scrolling stays
 * native (touch-action: pan-y); we only take over once the gesture is
 * clearly horizontal. A long swipe triggers the last (destructive) action.
 */
export function SwipeRow({
  id,
  actions,
  children,
}: {
  id: string;
  actions: SwipeAction[];
  children: ComponentChildren;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    x0: number;
    y0: number;
    base: number;
    x: number;
    mode: 'idle' | 'h' | 'v';
    t0: number;
  } | null>(null);
  const width = ACTION_W * actions.length;
  const isOpen = openRow.value === id;
  const pastFullRef = useRef(false);
  const suppressClickRef = useRef(false);

  const set = (x: number, animate: boolean): void => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 420ms var(--spring)' : 'none';
    el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
    wrapRef.current?.style.setProperty('--reveal', String(Math.min(1, -x / width)));
  };

  useEffect(() => {
    if (!gestureRef.current) set(isOpen ? -width : 0, true);
  }, [isOpen, width]);

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gestureRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      base: isOpen ? -width : 0,
      x: 0,
      mode: 'idle',
      t0: performance.now(),
    };
  };
  const onMove = (e: PointerEvent): void => {
    const s = gestureRef.current;
    if (!s) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (s.mode === 'idle') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
      if (s.mode === 'h') {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        if (openRow.value !== id) openRow.value = null;
      }
    }
    if (s.mode !== 'h') return;
    let x = s.base + dx;
    if (x > 0) x = x / 4; // rubber band to the right
    const full = wrapRef.current ? -wrapRef.current.offsetWidth * 0.62 : -9999;
    if (x < -width) x = -width + (x + width) * (x < full ? 1 : 0.55);
    const past = x < full;
    if (past !== pastFullRef.current) {
      pastFullRef.current = past;
      haptic('medium');
      wrapRef.current?.classList.toggle('full', past);
    }
    s.x = x;
    set(x, false);
  };
  const onUp = (): void => {
    const s = gestureRef.current;
    gestureRef.current = null;
    if (!s || s.mode !== 'h') return;
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 50);
    const v = (s.x - s.base) / Math.max(1, performance.now() - s.t0);
    if (pastFullRef.current) {
      pastFullRef.current = false;
      wrapRef.current?.classList.remove('full');
      openRow.value = null;
      set(0, true);
      actions[actions.length - 1]?.onAction();
      return;
    }
    const open = s.x < -width / 2 || v < -0.5;
    openRow.value = open ? id : null;
    set(open ? -width : 0, true);
  };

  return (
    <div class="swipe" ref={wrapRef} data-open={isOpen}>
      <div class="swipe-actions" style={{ width: `${width}px` }}>
        {actions.map((a, i) => (
          <button
            key={a.label}
            type="button"
            class={`swipe-action tone-${a.tone}`}
            style={{ '--i': String(actions.length - i) }}
            data-testid={a.testid}
            onClick={() => {
              openRow.value = null;
              a.onAction();
            }}
            tabIndex={isOpen ? 0 : -1}
          >
            <span class="swipe-icon">
              <Icon name={a.icon} size={20} stroke={2.1} />
            </span>
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div
        class="swipe-content"
        ref={contentRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => {
          if (suppressClickRef.current || openRow.value === id) {
            e.stopPropagation();
            e.preventDefault();
            openRow.value = null;
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function closeSwipeRows(): void {
  openRow.value = null;
}
