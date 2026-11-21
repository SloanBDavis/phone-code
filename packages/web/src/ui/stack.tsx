import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { lastAnim, leaving, pop, stack, type Entry, type Route } from '../lib/nav';
import { haptic, reducedMotion } from '../lib/util';

const DUR = 460;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const UNDER = -28; // percent the covered screen shifts left (parallax)
const DIM = 0.22;

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

  useLayoutEffect(() => {
    const old = prevRef.current;
    if (old === entries) return;
    prevRef.current = entries;
    const host = hostsIn(rootRef.current);
    const anim = lastAnim.peek();
    const topEl = host(entries[entries.length - 1]?.key);
    const underEl = host(entries[entries.length - 2]?.key);

    const settle = (): void => {
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
      dim.onfinish = settle;
      return;
    }

    const exitEl = host(leaving.peek()?.key);
    if (anim === 'pop' && exitEl && topEl && motion) {
      topEl.style.visibility = '';
      exitEl.classList.add('moving');
      const opts = { duration: DUR * 0.85, easing: EASE };
      exitEl.animate([{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(100%,0,0)' }], {
        ...opts,
        fill: 'forwards',
      });
      topEl.animate([{ transform: `translate3d(${UNDER}%,0,0)` }, { transform: 'translate3d(0,0,0)' }], opts);
      const dim = dimOf(topEl).animate([{ opacity: DIM }, { opacity: 0 }], opts);
      dim.onfinish = () => {
        leaving.value = null;
        settle();
      };
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
  dx: number;
  w: number;
  id: number;
}

function EdgeSwipe({
  rootRef,
  entries,
}: {
  rootRef: { current: HTMLDivElement | null };
  entries: Entry[];
}): JSX.Element {
  const swipeRef = useRef<SwipeState | null>(null);

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

  const finish = (s: SwipeState, commit: boolean, velocity: number): void => {
    const { top, under } = parts();
    if (!top || !under) return;
    const p = Math.max(0, Math.min(1, s.dx / s.w));
    const ms = Math.max(
      160,
      Math.min(380, ((commit ? 1 - p : p) * DUR) / Math.max(1, Math.abs(velocity) * 1.4)),
    );
    const opts: KeyframeAnimationOptions = {
      duration: ms,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'forwards',
    };
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
      for (const el of [top, under, dimOf(under)]) for (const x of el.getAnimations()) x.cancel();
      if (commit) {
        top.style.transform = 'translate3d(100%,0,0)';
        under.style.transform = '';
        dimOf(under).style.opacity = '0';
        pop(true);
      } else {
        top.style.transform = '';
        top.classList.remove('moving');
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
        e.currentTarget.setPointerCapture(e.pointerId);
        const w = e.currentTarget.parentElement?.offsetWidth ?? innerWidth;
        swipeRef.current = { x0: e.clientX, t0: performance.now(), dx: 0, w, id: e.pointerId };
        parts().top?.classList.add('moving');
      }}
      onPointerMove={(e) => {
        const s = swipeRef.current;
        if (!s || s.id !== e.pointerId) return;
        s.dx = Math.max(0, e.clientX - s.x0);
        move(s.dx, s.w);
      }}
      onPointerUp={() => {
        const s = swipeRef.current;
        if (!s) return;
        swipeRef.current = null;
        const v = s.dx / Math.max(1, performance.now() - s.t0);
        const commit = s.dx > s.w * 0.35 || (v > 0.45 && s.dx > 30);
        if (commit) haptic('light');
        finish(s, commit, v);
      }}
      onPointerCancel={() => {
        const s = swipeRef.current;
        swipeRef.current = null;
        if (s) finish(s, false, 0);
      }}
    />
  );
}
