import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useReducer, useRef } from 'preact/hooks';
import { lastAnim, pop, stack, type Entry, type Route } from '../lib/nav';
import { haptic, reducedMotion } from '../lib/util';

const DUR = 460;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const UNDER = -28; // percent the covered screen shifts left (parallax)
const DIM = 0.22;

/**
 * Push/pop navigation with an interactive slide and swipe-back from the
 * left edge. Screens below the top stay mounted (scroll positions and state
 * survive) but are hidden from paint until a transition reveals them.
 */
export function Stack({
  render,
}: {
  render: (route: Route, top: boolean) => ComponentChildren;
}): JSX.Element {
  const entries = stack.value;
  const elsRef = useRef(new Map<number, HTMLDivElement>());
  const prevRef = useRef<Entry[]>(entries);
  const leavingRef = useRef<Entry | null>(null);
  const [, force] = useReducer((n: number) => n + 1, 0);

  // Decide synchronously (during render) whether a popped screen must stay
  // mounted for its exit animation, so it never flashes away for a frame.
  if (entries !== prevRef.current) {
    const old = prevRef.current;
    const popped = old.length > entries.length ? old[old.length - 1] : undefined;
    leavingRef.current = popped && lastAnim.value === 'pop' && !reducedMotion() ? popped : null;
  }

  useLayoutEffect(() => {
    const old = prevRef.current;
    prevRef.current = entries;
    const anim = lastAnim.value;
    const top = entries[entries.length - 1];
    const under = entries[entries.length - 2];
    const topEl = top ? elsRef.current.get(top.key) : undefined;
    const underEl = under ? elsRef.current.get(under.key) : undefined;

    const settle = (): void => {
      entries.forEach((e, i) => {
        const el = elsRef.current.get(e.key);
        if (!el) return;
        el.style.transform = '';
        el.style.visibility = i === entries.length - 1 ? '' : 'hidden';
        el.classList.remove('moving');
        dimOf(el).style.opacity = '0';
      });
    };

    if (old === entries) return;
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
      dim.onfinish = settle;
      return;
    }

    const leavingEntry = leavingRef.current;
    const leaveEl = leavingEntry ? elsRef.current.get(leavingEntry.key) : undefined;
    if (anim === 'pop' && leaveEl && topEl && motion) {
      topEl.style.visibility = '';
      leaveEl.classList.add('moving');
      leaveEl.animate([{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(100%,0,0)' }], {
        duration: DUR * 0.85,
        easing: EASE,
        fill: 'forwards',
      });
      topEl.animate([{ transform: `translate3d(${UNDER}%,0,0)` }, { transform: 'translate3d(0,0,0)' }], {
        duration: DUR * 0.85,
        easing: EASE,
      });
      const dim = dimOf(topEl).animate([{ opacity: DIM }, { opacity: 0 }], {
        duration: DUR * 0.85,
        easing: EASE,
      });
      dim.onfinish = () => {
        leavingRef.current = null;
        settle();
        force(0);
      };
      return;
    }
    leavingRef.current = null;
    settle();
  }, [entries]);

  const shown = leavingRef.current ? [...entries, leavingRef.current] : entries;
  const topKey = entries[entries.length - 1]?.key;

  return (
    <div class="stack">
      {shown.map((e) => {
        const isTop = e.key === topKey;
        return (
          <div
            key={e.key}
            class="screen-host"
            ref={(el) => {
              if (el) elsRef.current.set(e.key, el);
              else elsRef.current.delete(e.key);
            }}
            inert={!isTop}
          >
            {render(e.route, isTop)}
            <div class="screen-dim" />
            {isTop && entries.length > 1 && <EdgeSwipe els={elsRef.current} entries={entries} />}
          </div>
        );
      })}
    </div>
  );
}

function dimOf(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>(':scope > .screen-dim') ?? el;
}

function EdgeSwipe({ els, entries }: { els: Map<number, HTMLDivElement>; entries: Entry[] }): JSX.Element {
  const stRef = useRef<{ x0: number; t0: number; dx: number; w: number; id: number } | null>(null);

  const parts = (): { top?: HTMLDivElement; under?: HTMLDivElement } => {
    const top = entries[entries.length - 1];
    const under = entries[entries.length - 2];
    return { top: top && els.get(top.key), under: under && els.get(under.key) };
  };

  const move = (dx: number): void => {
    const { top, under } = parts();
    const w = stRef.current?.w ?? innerWidth;
    const p = Math.max(0, Math.min(1, dx / w));
    if (top) top.style.transform = `translate3d(${p * 100}%,0,0)`;
    if (under) {
      under.style.visibility = '';
      under.style.transform = `translate3d(${UNDER * (1 - p)}%,0,0)`;
      dimOf(under).style.opacity = String(DIM * (1 - p));
    }
  };

  const finish = (commit: boolean, velocity: number): void => {
    const { top, under } = parts();
    const w = stRef.current?.w ?? innerWidth;
    const dx = stRef.current?.dx ?? 0;
    const p = Math.max(0, Math.min(1, dx / w));
    const ms = Math.max(
      160,
      Math.min(380, ((commit ? 1 - p : p) * DUR) / Math.max(1, Math.abs(velocity) * 1.4)),
    );
    const opts: KeyframeAnimationOptions = {
      duration: ms,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'forwards',
    };
    if (!top || !under) return;
    const a = top.animate(
      [{ transform: `translate3d(${p * 100}%,0,0)` }, { transform: `translate3d(${commit ? 100 : 0}%,0,0)` }],
      opts,
    );
    under.animate(
      [
        { transform: `translate3d(${UNDER * (1 - p)}%,0,0)` },
        { transform: `translate3d(${commit ? 0 : UNDER}%,0,0)` },
      ],
      opts,
    );
    dimOf(under).animate([{ opacity: DIM * (1 - p) }, { opacity: commit ? 0 : DIM }], opts);
    a.onfinish = () => {
      for (const el of [top, under]) {
        el.getAnimations().forEach((x) => x.cancel());
        dimOf(el)
          .getAnimations()
          .forEach((x) => x.cancel());
      }
      if (commit) {
        top.style.transform = 'translate3d(100%,0,0)';
        under.style.transform = '';
        dimOf(under).style.opacity = '0';
        pop(true);
      } else {
        top.style.transform = '';
        under.style.transform = '';
        under.style.visibility = 'hidden';
        dimOf(under).style.opacity = '0';
      }
    };
  };

  return (
    <div
      class="edge-swipe"
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const host = (e.currentTarget as HTMLElement).parentElement;
        stRef.current = {
          x0: e.clientX,
          t0: performance.now(),
          dx: 0,
          w: host?.offsetWidth ?? innerWidth,
          id: e.pointerId,
        };
        parts().top?.classList.add('moving');
      }}
      onPointerMove={(e) => {
        const s = stRef.current;
        if (!s || s.id !== e.pointerId) return;
        s.dx = Math.max(0, e.clientX - s.x0);
        move(s.dx);
      }}
      onPointerUp={(e) => {
        const s = stRef.current;
        if (!s) return;
        const v = s.dx / Math.max(1, performance.now() - s.t0);
        const commit = s.dx > s.w * 0.35 || (v > 0.45 && s.dx > 30);
        if (commit) haptic('light');
        finish(commit, v);
        stRef.current = null;
        void e;
      }}
      onPointerCancel={() => {
        finish(false, 0);
        stRef.current = null;
      }}
    />
  );
}
