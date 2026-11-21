import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { lastAnim, leaving, pop, stack, type Entry, type Route } from '../lib/nav';
import { afterAnimation, haptic, reducedMotion } from '../lib/util';

const DUR = 460;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const UNDER = -28; // percent the covered screen shifts left (parallax)
const DIM = 0.22;

/** Progress (0..1) of a swipe-back that just committed; the pop animation starts there. */
let swipeFrom = 0;

type Hosts = (key: number | undefined) => HTMLElement | undefined;

function hostsIn(root: HTMLElement | null): Hosts {
  return (key) =>
    key === undefined
      ? undefined
      : (root?.querySelector<HTMLElement>(`:scope > [data-key="${key}"]`) ?? undefined);
}

function dimOf(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>(':scope > .screen-dim') ?? el;
}

/**
 * Push/pop navigation with an interactive slide and swipe-back from the
 * left edge. Screens below the top stay mounted (scroll positions and state
 * survive) but are hidden from paint until a transition reveals them. A
 * popped screen stays mounted (nav.leaving) until its exit animation ends.
 */
export function Stack({
  render,
}: {
  render: (route: Route, top: boolean) => ComponentChildren;
}): JSX.Element {
  const entries = stack.value;
  const exiting = leaving.value;
  const rootRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<Entry[]>(entries);
  const genRef = useRef(0);

  useLayoutEffect(() => {
    const old = prevRef.current;
    if (old === entries) return;
    prevRef.current = entries;
    // Animations are decoration: the final state is applied when they finish, are
    // cancelled, or after a timeout, and a newer navigation supersedes older ones.
    const gen = ++genRef.current;
    const host = hostsIn(rootRef.current);
    const anim = lastAnim.peek();
    const topEl = host(entries[entries.length - 1]?.key);
    const underEl = host(entries[entries.length - 2]?.key);

    const settle = (): void => {
      if (gen !== genRef.current) return;
      entries.forEach((e, i) => {
        const el = host(e.key);
        if (!el) return;
        el.style.transform = '';
        el.style.visibility = i === entries.length - 1 ? '' : 'hidden';
        el.classList.remove('moving');
        dimOf(el).style.opacity = '0';
      });
    };

    const motion = !reducedMotion();
    if (anim === 'push' && topEl && underEl && motion && old.length < entries.length) {
      underEl.style.visibility = '';
      topEl.classList.add('moving');
      topEl.animate([{ transform: 'translate3d(100%,0,0)' }, { transform: 'translate3d(0,0,0)' }], {
        duration: DUR,
        easing: EASE,
      });
      underEl.animate([{ transform: 'translate3d(0,0,0)' }, { transform: `translate3d(${UNDER}%,0,0)` }], {
        duration: DUR,
        easing: EASE,
      });
      const dim = dimOf(underEl).animate([{ opacity: 0 }, { opacity: DIM }], { duration: DUR, easing: EASE });
      afterAnimation(dim, DUR, settle);
      return;
    }

    const exitEl = host(leaving.peek()?.key);
    // A committed swipe-back continues from where the finger let go.
    const from = swipeFrom;
    swipeFrom = 0;
    if (anim === 'pop' && exitEl && topEl && motion) {
      topEl.style.visibility = '';
      exitEl.classList.add('moving');
      const opts = { duration: Math.max(160, DUR * 0.85 * (1 - from)), easing: EASE };
      exitEl.animate(
        [{ transform: `translate3d(${from * 100}%,0,0)` }, { transform: 'translate3d(100%,0,0)' }],
        { ...opts, fill: 'forwards' },
      );
      topEl.animate(
        [{ transform: `translate3d(${UNDER * (1 - from)}%,0,0)` }, { transform: 'translate3d(0,0,0)' }],
        opts,
      );
      const dim = dimOf(topEl).animate([{ opacity: DIM * (1 - from) }, { opacity: 0 }], opts);
      afterAnimation(dim, opts.duration, () => {
        if (gen !== genRef.current) return;
        leaving.value = null;
        settle();
      });
      return;
    }
    leaving.value = null;
    settle();
  }, [entries]);

  const shown = exiting && !entries.includes(exiting) ? [...entries, exiting] : entries;
  const topKey = entries[entries.length - 1]?.key;

  return (
    <div class="stack" ref={rootRef}>
      {shown.map((e) => {
        const isTop = e.key === topKey;
        return (
          <div key={e.key} class="screen-host" data-key={e.key} inert={!isTop}>
            {render(e.route, isTop)}
            <div class="screen-dim" />
            {isTop && entries.length > 1 && <EdgeSwipe rootRef={rootRef} entries={entries} />}
          </div>
        );
      })}
    </div>
  );
}

interface SwipeState {
  x0: number;
  t0: number;
  /** Last position and time, for the release velocity. */
  x: number;
  t: number;
  v: number;
  w: number;
  watchdog: number;
}

/** A drag that hears nothing for this long is treated as released (lost end events). */
const WATCHDOG_MS = 2500;

/**
 * Interactive swipe-back from the left edge.
 *
 * iOS can end a touch in several ways: pointerup, pointercancel (a pan took
 * over), touchend/touchcancel without the matching pointer event (a system
 * gesture claimed the touch), or nothing at all for this element (lost
 * capture, app backgrounded). Every one of them, plus a watchdog, ends the
 * gesture, and every end settles fully open or fully closed by distance and
 * velocity. Committing pops the stack synchronously; the slide is decoration
 * that the Stack continues from the release point.
 */
function EdgeSwipe({
  rootRef,
  entries,
}: {
  rootRef: { current: HTMLDivElement | null };
  entries: Entry[];
}): JSX.Element {
  const swipeRef = useRef<SwipeState | null>(null);
  const settleRef = useRef<(() => void) | null>(null);

  const parts = (): { top?: HTMLElement; under?: HTMLElement } => {
    const host = hostsIn(rootRef.current);
    return { top: host(entries[entries.length - 1]?.key), under: host(entries[entries.length - 2]?.key) };
  };

  const move = (dx: number, w: number): void => {
    const { top, under } = parts();
    const p = Math.max(0, Math.min(1, dx / w));
    if (top) top.style.transform = `translate3d(${p * 100}%,0,0)`;
    if (under) {
      under.style.visibility = '';
      under.style.transform = `translate3d(${UNDER * (1 - p)}%,0,0)`;
      dimOf(under).style.opacity = String(DIM * (1 - p));
    }
  };

  /** Snap back to fully open (the top screen stays). */
  const restore = (p: number, velocity: number): void => {
    const { top, under } = parts();
    if (!top || !under) return;
    const ms = Math.max(160, Math.min(380, (p * DUR) / Math.max(1, Math.abs(velocity) * 1.4)));
    const opts: KeyframeAnimationOptions = { duration: ms, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
    // Final state first: the animations below only decorate the way there.
    top.style.transform = '';
    under.style.transform = '';
    dimOf(under).style.opacity = '0';
    const a = top.animate([{ transform: `translate3d(${p * 100}%,0,0)` }, { transform: 'none' }], opts);
    under.animate(
      [{ transform: `translate3d(${UNDER * (1 - p)}%,0,0)` }, { transform: `translate3d(${UNDER}%,0,0)` }],
      opts,
    );
    dimOf(under).animate([{ opacity: DIM * (1 - p) }, { opacity: DIM }], opts);
    const finish = (): void => {
      settleRef.current = null;
      for (const el of [top, under, dimOf(under)]) for (const x of el.getAnimations()) x.cancel();
      top.classList.remove('moving');
      // Hide the covered screen only if no new drag revealed it meanwhile.
      if (!swipeRef.current) under.style.visibility = 'hidden';
    };
    settleRef.current = finish;
    afterAnimation(a, ms, finish);
  };

  const end = (): void => {
    const s = swipeRef.current;
    if (!s) return;
    swipeRef.current = null;
    clearTimeout(s.watchdog);
    const dx = Math.max(0, s.x - s.x0);
    const p = Math.max(0, Math.min(1, dx / s.w));
    // Velocity of the last stretch, px/ms (zero once the finger rested); a fling right commits even when short.
    const v = performance.now() - s.t > 120 ? 0 : s.v;
    const commit = p >= 0.35 || (v > 0.45 && dx > 30);
    if (commit) {
      haptic('light');
      swipeFrom = p;
      pop();
    } else restore(p, v);
  };

  const begin = (x: number): void => {
    if (swipeRef.current) return; // the same touch, seen as both a touch and a pointer
    settleRef.current?.(); // a new drag during a settle starts from the settled state
    const w = rootRef.current?.offsetWidth || innerWidth;
    const now = performance.now();
    swipeRef.current = { x0: x, t0: now, x, t: now, v: 0, w, watchdog: window.setTimeout(end, WATCHDOG_MS) };
    parts().top?.classList.add('moving');
  };

  const drag = (x: number): void => {
    const s = swipeRef.current;
    if (!s) return;
    const now = performance.now();
    const dt = Math.max(1, now - s.t);
    s.v = 0.7 * ((x - s.x) / dt) + 0.3 * s.v;
    s.x = x;
    s.t = now;
    clearTimeout(s.watchdog);
    s.watchdog = window.setTimeout(end, WATCHDOG_MS);
    move(Math.max(0, x - s.x0), s.w);
  };

  const endRef = useRef(end);
  useLayoutEffect(() => {
    endRef.current = end;
  });

  // Ends that may never reach the strip itself.
  useEffect(() => {
    const onEnd = (): void => endRef.current();
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') onEnd();
    };
    const opts = { capture: true, passive: true };
    for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const)
      addEventListener(t, onEnd, opts);
    addEventListener('blur', onEnd);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const)
        removeEventListener(t, onEnd, opts);
      removeEventListener('blur', onEnd);
      document.removeEventListener('visibilitychange', onHidden);
      const s = swipeRef.current;
      if (s) clearTimeout(s.watchdog);
    };
  }, []);

  return (
    <div
      class="edge-swipe"
      aria-hidden="true"
      data-testid="edge-swipe"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // capture is a nicety; the window listeners catch the release anyway
        }
        begin(e.clientX);
      }}
      onPointerMove={(e) => drag(e.clientX)}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (t && e.touches.length === 1) begin(t.clientX);
      }}
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (t) drag(t.clientX);
      }}
      onLostPointerCapture={(e) => {
        if (e.target === e.currentTarget) end();
      }}
    />
  );
}
