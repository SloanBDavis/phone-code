import { createContext, type ComponentChildren, type HTMLAttributes, type JSX } from 'preact';
import { signal } from '@preact/signals';
import { useContext, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { MAX_PANES, closePane, openBeside, openNew, panes } from '../lib/nav';
import { load, save } from '../lib/storage';
import { haptic } from '../lib/util';
import { GlassButton } from './glass';

/**
 * The app shell: the sidebar of chats and the main pane. On a phone the
 * sidebar is a drawer from the left (a button, or a swipe from the left edge;
 * a swipe left on the dimmed chat or a tap closes it). On a wide screen it is
 * a persistent column.
 */

const WIDE = '(min-width: 900px)';
export const wide = signal(typeof matchMedia === 'function' && matchMedia(WIDE).matches);
export const drawerOpen = signal(false);

export function openDrawer(): void {
  haptic('light');
  drawerOpen.value = true;
}

export function closeDrawer(): void {
  drawerOpen.value = false;
}

interface Drag {
  /** Progress the drag started from: 0 closed, 1 open. */
  from: number;
  x0: number;
  y0: number;
  x: number;
  t: number;
  v: number;
  w: number;
  /** Until the move is clearly horizontal, a vertical one gives the touch back. */
  locked: boolean;
  watchdog: number;
}

/** A drag that hears nothing for this long is treated as released (lost end events). */
const WATCHDOG_MS = 2500;
const SCRIM = 0.42;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const SB_MIN = 220;
const SB_MAX = 560;
const SB_DEFAULT = 320;
const clampWidth = (w: number): number => Math.min(SB_MAX, Math.max(SB_MIN, Math.round(w)));

/** The sidebar's width on a wide screen, as the user left it. */
const sidebarWidth = signal(clampWidth(load('pc.sidebarWidth', SB_DEFAULT, isNumber)));

/** On a wide screen, the sidebar put away (⌘B), as the user left it. */
export const sidebarHidden = signal(
  load('pc.sidebarHidden', false, (v): v is boolean => typeof v === 'boolean'),
);

/** Shows or puts away the chats: the column on a wide screen, the drawer on a phone. */
export function toggleSidebar(): void {
  if (!wide.peek()) {
    if (drawerOpen.peek()) closeDrawer();
    else openDrawer();
    return;
  }
  sidebarHidden.value = !sidebarHidden.peek();
  save('pc.sidebarHidden', sidebarHidden.value);
}

/**
 * The line between the sidebar and the main pane: drag it to make the sidebar
 * narrower or wider (kept for next time), double-click for the usual width.
 */
function SidebarResizer({ root }: { root: { current: HTMLDivElement | null } }): JSX.Element {
  const w = sidebarHidden.value ? 0 : sidebarWidth.value;
  useLayoutEffect(() => {
    root.current?.style.setProperty('--sb-w', `${w}px`);
    // Also for what is drawn outside the shell (the Mac app's window strip).
    document.documentElement.style.setProperty('--sb-w', `${w}px`);
  }, [root, w]);
  const move = (e: PointerEvent): void => {
    const left = root.current?.getBoundingClientRect().left ?? 0;
    sidebarWidth.value = clampWidth(e.clientX - left);
  };
  return (
    <button
      type="button"
      class="sb-resizer"
      aria-label={`Resize the sidebar (${w} points wide; arrow keys move it)`}
      data-testid="sidebar-resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
      }}
      onPointerUp={(e) => {
        e.currentTarget.classList.remove('dragging');
        save('pc.sidebarWidth', sidebarWidth.value);
      }}
      onDblClick={() => {
        sidebarWidth.value = SB_DEFAULT;
        save('pc.sidebarWidth', SB_DEFAULT);
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (step === 0) return;
        e.preventDefault();
        sidebarWidth.value = clampWidth(sidebarWidth.value + step);
        save('pc.sidebarWidth', sidebarWidth.value);
      }}
    />
  );
}

export function Shell({
  sidebar,
  children,
}: {
  sidebar: ComponentChildren;
  children: ComponentChildren;
}): JSX.Element {
  const isWide = wide.value;
  const open = drawerOpen.value && !isWide;
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    const mq = matchMedia(WIDE);
    const on = (): void => {
      wide.value = mq.matches;
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && drawerOpen.peek()) closeDrawer();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const parts = (): { side?: HTMLElement; scrim?: HTMLElement } => {
    const root = rootRef.current;
    return {
      side: root?.querySelector<HTMLElement>(':scope > .sidebar') ?? undefined,
      scrim: root?.querySelector<HTMLElement>(':scope > .drawer-scrim') ?? undefined,
    };
  };

  /** Follows the finger: inline styles with transitions off. */
  const follow = (p: number): void => {
    const { side, scrim } = parts();
    if (side) {
      side.style.transition = 'none';
      side.style.transform = `translate3d(${(p - 1) * 100}%,0,0)`;
      side.style.visibility = 'visible';
    }
    if (scrim) {
      scrim.style.transition = 'none';
      scrim.style.opacity = String(p * SCRIM);
      scrim.style.visibility = 'visible';
    }
  };

  /** Hands the position back to the stylesheet; its transition animates to the settled state. */
  const release = (): void => {
    const { side, scrim } = parts();
    for (const el of [side, scrim]) {
      if (!el) continue;
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
      el.style.visibility = '';
    }
    rootRef.current?.classList.remove('dragging');
  };

  /**
   * Every way a touch can end on iOS (pointerup, pointercancel, touchend,
   * touchcancel alone, lost capture, blur, the app hidden, or nothing at all,
   * caught by the watchdog) lands here, and the drawer settles fully open or
   * fully closed by distance and velocity. State changes synchronously; the
   * slide is a CSS transition that nothing waits for.
   */
  const end = (): void => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    clearTimeout(d.watchdog);
    if (!d.locked) {
      // A tap (on the dimmed chat) closes; a vertical move changes nothing.
      if (d.from === 1 && Math.abs(d.x - d.x0) < 6) closeDrawer();
      release();
      return;
    }
    const p = Math.max(0, Math.min(1, d.from + (d.x - d.x0) / d.w));
    const v = performance.now() - d.t > 120 ? 0 : d.v;
    const next = v > 0.45 ? true : v < -0.45 ? false : p >= 0.5;
    if (next !== d.from > 0.5) haptic('light');
    drawerOpen.value = next;
    release();
  };

  const begin = (x: number, y: number, from: number): void => {
    if (dragRef.current) return; // the same touch, seen as both a touch and a pointer
    const w = parts().side?.offsetWidth || Math.min(innerWidth * 0.86, 340);
    dragRef.current = {
      from,
      x0: x,
      y0: y,
      x,
      t: performance.now(),
      v: 0,
      w,
      locked: false,
      watchdog: window.setTimeout(end, WATCHDOG_MS),
    };
  };

  const move = (x: number, y: number): void => {
    const d = dragRef.current;
    if (!d) return;
    const now = performance.now();
    d.v = 0.7 * ((x - d.x) / Math.max(1, now - d.t)) + 0.3 * d.v;
    d.x = x;
    d.t = now;
    clearTimeout(d.watchdog);
    d.watchdog = window.setTimeout(end, WATCHDOG_MS);
    if (!d.locked) {
      const dx = Math.abs(x - d.x0);
      const dy = Math.abs(y - d.y0);
      if (dx < 8 && dy < 8) return;
      if (dy > dx) {
        // Vertical: not ours. Drop it without changing anything.
        clearTimeout(d.watchdog);
        dragRef.current = null;
        release();
        return;
      }
      d.locked = true;
      rootRef.current?.classList.add('dragging');
    }
    follow(Math.max(0, Math.min(1, d.from + (x - d.x0) / d.w)));
  };

  const endRef = useRef(end);
  useLayoutEffect(() => {
    endRef.current = end;
  });
  useEffect(() => {
    const onEnd = (): void => endRef.current();
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') onEnd();
    };
    const opts = { capture: true, passive: true };
    const types = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const;
    for (const t of types) addEventListener(t, onEnd, opts);
    addEventListener('blur', onEnd);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      for (const t of types) removeEventListener(t, onEnd, opts);
      removeEventListener('blur', onEnd);
      document.removeEventListener('visibilitychange', onHidden);
      const d = dragRef.current;
      if (d) clearTimeout(d.watchdog);
    };
  }, []);

  // Switching to the wide layout mid-drag: settle.
  useEffect(() => {
    if (isWide) endRef.current();
  }, [isWide]);

  const handlers = (from: number): HTMLAttributes<HTMLDivElement> => ({
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // capture is a nicety; the window listeners catch the release anyway
      }
      begin(e.clientX, e.clientY, from);
    },
    onPointerMove: (e) => move(e.clientX, e.clientY),
    onTouchStart: (e) => {
      const t = e.touches[0];
      if (t && e.touches.length === 1) begin(t.clientX, t.clientY, from);
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (t) move(t.clientX, t.clientY);
    },
    onLostPointerCapture: (e) => {
      if (e.target === e.currentTarget) end();
    },
  });

  return (
    <div
      ref={rootRef}
      class={`shell ${isWide ? 'wide' : 'narrow'} ${open ? 'drawer-open' : ''} ${isWide && sidebarHidden.value ? 'sb-hidden' : ''}`}
      data-testid="shell"
      data-drawer={open ? 'open' : 'closed'}
    >
      <aside
        class={`sidebar ${isWide ? '' : 'glass glass-regular'}`}
        inert={isWide ? sidebarHidden.value : !open}
        aria-label="Chats"
        data-testid="sidebar"
      >
        {sidebar}
      </aside>
      <main class="main" inert={open}>
        {children}
      </main>
      {isWide && <SidebarResizer root={rootRef} />}
      {!isWide && <div class="drawer-scrim" aria-hidden="true" data-testid="drawer-scrim" {...handlers(1)} />}
      {!isWide && !open && (
        <div class="edge-swipe" aria-hidden="true" data-testid="edge-swipe" {...handlers(0)} />
      )}
    </div>
  );
}

/** Which pane a screen is in (its key in `panes`). */
export const PaneContext = createContext(0);

/** What a chat row dragged out of the sidebar carries: the session's id. */
export const SESSION_DRAG = 'application/x-phonecode-session';

/**
 * The buttons every main pane has. On a phone: the chats drawer and a new
 * chat. On a wide screen: a new chat beside this one, and closing the pane
 * when there are several.
 */
export function usePaneButtons(): { left: JSX.Element | null; right: JSX.Element | null } {
  const k = useContext(PaneContext);
  if (wide.value) {
    const all = panes.value;
    const at = all.findIndex((p) => p.k === k);
    return {
      // The chats put away: a way back, on the first pane.
      left:
        sidebarHidden.value && at === 0 ? (
          <GlassButton
            icon="sidebar"
            label="Show chats"
            iconSize={22}
            onClick={toggleSidebar}
            testid="show-sidebar"
          />
        ) : null,
      right: (
        <>
          {all.length < MAX_PANES && (
            <GlassButton
              icon="split"
              label="New chat beside this one"
              iconSize={20}
              onClick={() => openBeside({ name: 'new' }, at)}
              testid="pane-split"
            />
          )}
          {all.length > 1 && (
            <GlassButton
              icon="close"
              label="Close this pane"
              iconSize={18}
              onClick={() => closePane(k)}
              testid="pane-close"
            />
          )}
        </>
      ),
    };
  }
  return {
    left: (
      <GlassButton icon="sidebar" label="Chats" iconSize={22} onClick={openDrawer} testid="open-sidebar" />
    ),
    right: <GlassButton icon="compose" label="New chat" iconSize={21} onClick={openNew} testid="new-chat" />,
  };
}
