import type { ComponentChildren, JSX, TargetedPointerEvent } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { attachRefraction } from '../lib/glass';
import { haptic, reducedMotion, soon } from '../lib/util';
import { Icon, type IconName } from './icons';

/**
 * Overlays (sheets, menus, alerts, toasts) are rendered by one host at the
 * root, opened imperatively from anywhere: `openSheet(close => <X/>)`.
 */

interface Layer {
  id: number;
  render: (close: () => void, closing: boolean) => ComponentChildren;
  closing: boolean;
  onClosed?: () => void;
}

const layers = signal<Layer[]>([]);
let nextId = 1;

function addLayer(render: Layer['render'], onClosed?: () => void): () => void {
  const id = nextId++;
  layers.value = [...layers.value, { id, render, closing: false, onClosed }];
  return () => closeLayer(id);
}

function closeLayer(id: number): void {
  layers.value = layers.value.map((l) => (l.id === id ? { ...l, closing: true } : l));
}

function removeLayer(id: number): void {
  const l = layers.value.find((x) => x.id === id);
  layers.value = layers.value.filter((x) => x.id !== id);
  l?.onClosed?.();
}

export function OverlayHost(): JSX.Element {
  return (
    <>
      {layers.value.map((l) => (
        <LayerCtx key={l.id} layer={l} />
      ))}
      <ToastHost />
    </>
  );
}

const ANIM_MS = 320;

/** Whether a sheet, menu or dialog is open (shortcuts of the page wait while one is). */
export const overlayOpen = (): boolean => layers.peek().some((l) => !l.closing);

// ------------------------------------------------------------ keyboard focus

/** The open layers' elements, newest last: Escape and Tab belong to the top one. */
const focusStack: HTMLElement[] = [];

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * A layer's keyboard focus: it takes focus when it opens (`initial`, else its first
 * control), keeps Tab inside, closes on Escape when it is the top layer, and gives
 * focus back to what had it when it closes.
 */
function useLayerFocus(
  ref: { current: HTMLElement | null },
  close: () => void,
  initial?: (el: HTMLElement) => HTMLElement | null | undefined,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  // Before the first paint: a key pressed as the layer appears already goes to it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusStack.push(el);
    // A menu is hidden until it is placed, and a hidden element cannot take focus: try
    // again on the next frames until it has it.
    let tries = 10;
    let frame = 0;
    const take = (): void => {
      if (el.contains(document.activeElement) || !el.isConnected) return;
      const first = initial?.(el) ?? focusables(el)[0] ?? el;
      first.focus({ preventScroll: true });
      if (!el.contains(document.activeElement) && --tries > 0) frame = requestAnimationFrame(take);
    };
    take();
    const onKey = (e: KeyboardEvent): void => {
      if (focusStack.at(-1) !== el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const all = focusables(el);
      if (all.length === 0) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      const at = active instanceof HTMLElement ? all.indexOf(active) : -1;
      const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at === all.length - 1 ? 0 : at + 1;
      e.preventDefault();
      all[next]?.focus();
    };
    // Capture: before the page's own keys, so Escape closes this layer only.
    addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('keydown', onKey, true);
      focusStack.splice(focusStack.indexOf(el), 1);
      if (opener?.isConnected && !focusStack.some((x) => x.contains(document.activeElement)))
        opener.focus({ preventScroll: true });
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per layer
  }, []);
}

function LayerCtx({ layer }: { layer: Layer }): JSX.Element {
  useEffect(() => {
    if (!layer.closing) return undefined;
    const t = setTimeout(() => removeLayer(layer.id), reducedMotion() ? 10 : ANIM_MS);
    return () => clearTimeout(t);
  }, [layer.closing, layer.id]);
  return <>{layer.render(() => closeLayer(layer.id), layer.closing)}</>;
}

/** A full-screen layer with its own look (e.g. the image viewer). `closing` turns true on close. */
export function openLayer(
  render: (close: () => void, closing: boolean) => ComponentChildren,
  onClosed?: () => void,
): () => void {
  return addLayer(render, onClosed);
}

// ------------------------------------------------------------------ sheet

export interface SheetOptions {
  /** Called once the sheet has fully closed. */
  onClosed?: () => void;
  /** Start at the large detent (full height minus the top inset). */
  large?: boolean;
  testid?: string;
  label?: string;
}

/** Opens a bottom sheet. `render` receives a `close` callback. */
export function openSheet(
  render: (close: () => void) => ComponentChildren,
  opts: SheetOptions = {},
): () => void {
  return addLayer(
    (c, closing) => (
      <Sheet close={c} closing={closing} opts={opts}>
        {render(c)}
      </Sheet>
    ),
    opts.onClosed,
  );
}

function Sheet({
  children,
  close,
  closing,
  opts,
}: {
  children: ComponentChildren;
  close: () => void;
  closing: boolean;
  opts: SheetOptions;
}): JSX.Element {
  const sheetRef = useRef<HTMLDialogElement>(null);
  const [entered, setEntered] = useState(false);
  const dragRef = useRef<{
    y0: number;
    t0: number;
    dy: number;
    active: boolean;
    scroller: HTMLElement | null;
  } | null>(null);

  // The slide-in is decoration: `entered` flips on the next frame or a timer, never on an animation event.
  useLayoutEffect(() => soon(() => setEntered(true)), []);

  useLayerFocus(sheetRef, close);

  const setY = (y: number, animate: boolean): void => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition = animate ? '' : 'none';
    el.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element) || target.closest('input, textarea, select, [data-nodrag]')) return;
    const scroller = target.closest<HTMLElement>('.sheet-scroll');
    dragRef.current = { y0: e.clientY, t0: performance.now(), dy: 0, active: false, scroller };
  };
  const onPointerMove = (e: TargetedPointerEvent<HTMLDialogElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (Math.abs(dy) < 6) return;
      // Only pull the sheet when the inner list is at its top.
      if (dy < 0 || (d.scroller && d.scroller.scrollTop > 0)) {
        dragRef.current = null;
        return;
      }
      d.active = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // the window listeners still see the release
      }
    }
    d.dy = dy;
    setY(dy > 0 ? dy : dy / 4, false);
  };
  const onPointerUp = (): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.active) return;
    const v = d.dy / Math.max(1, performance.now() - d.t0);
    if (d.dy > 140 || v > 0.7) {
      haptic('light');
      setY(0, true);
      close();
    } else setY(0, true);
  };

  // A drag can end without reaching the sheet (touchcancel only, lost capture):
  // any release anywhere settles it, open or dismissed.
  const upRef = useRef(onPointerUp);
  useLayoutEffect(() => {
    upRef.current = onPointerUp;
  });
  useEffect(() => {
    const up = (): void => upRef.current();
    const lo = { capture: true, passive: true };
    const types = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const;
    for (const t of types) addEventListener(t, up, lo);
    return () => {
      for (const t of types) removeEventListener(t, up, lo);
    };
  }, []);

  const state = closing ? 'out' : entered ? 'in' : 'pre';
  return (
    <div class={`sheet-layer ${state}`}>
      <div class="sheet-backdrop" onClick={close} aria-hidden="true" />
      <dialog
        open
        ref={sheetRef}
        class={`sheet glass glass-regular ${opts.large ? 'sheet-large' : ''}`}
        tabIndex={-1}
        aria-modal="true"
        aria-label={opts.label}
        data-testid={opts.testid}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={(e) => {
          // Only the capture the sheet took; a child's implicit capture moving here is not an end.
          if (e.target === e.currentTarget) onPointerUp();
        }}
      >
        <div class="sheet-grabber" aria-hidden="true" />
        {children}
      </dialog>
    </div>
  );
}

// ------------------------------------------------------------------ menu

export interface MenuItem {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  checked?: boolean;
  disabled?: boolean;
  testid?: string;
  /** Secondary line under the label. */
  hint?: string;
  /** Shown instead of the check column, e.g. a harness glyph. */
  lead?: ComponentChildren;
  /** Looks unavailable but stays tappable (e.g. to explain how to set it up). */
  dim?: boolean;
  onSelect: () => void;
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

/** Opens a glass context menu anchored to an element. */
export function openMenu(anchor: Element, sections: MenuSection[], opts: { testid?: string } = {}): void {
  if (!sections.some((x) => x.items.length)) return;
  haptic('light');
  addLayer((close, closing) => (
    <Menu anchor={anchor} sections={sections} close={close} closing={closing} testid={opts.testid} />
  ));
}

function Menu({
  anchor,
  sections,
  close,
  closing,
  testid,
}: {
  anchor: Element;
  sections: MenuSection[];
  close: () => void;
  closing: boolean;
  testid?: string;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; ox: string; oy: string } | null>(null);
  const [entered, setEntered] = useState(false);

  // Anchored to the element, not to where it was at open: on iPhone the keyboard
  // often closes right after the tap (the app shell grows back to full height and
  // the composer moves down), so the menu follows every viewport change.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return undefined;
    const root = document.querySelector<HTMLElement>('.app');
    let last = anchor.getBoundingClientRect();
    const place = (): void => {
      if (anchor.isConnected) last = anchor.getBoundingClientRect();
      const rect = last;
      const app = root?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
      const vw = app.width;
      const vh = app.height;
      const a = {
        left: rect.left - app.left,
        right: rect.right - app.left,
        top: rect.top - app.top,
        bottom: rect.bottom - app.top,
      };
      // Natural size first, then fit the side with more room; a long list scrolls inside.
      el.style.removeProperty('--menu-max');
      const w = el.offsetWidth;
      let h = el.offsetHeight;
      const margin = 10;
      const topLimit = margin + 40; // clear of the status bar
      const above = a.top - 8 - topLimit;
      const below = vh - margin - (a.bottom + 8);
      const openUp = h > below && above > below;
      const room = Math.max(120, openUp ? above : below);
      if (h > room) {
        el.style.setProperty('--menu-max', `${room}px`);
        h = room;
      }
      const alignRight = a.left + rect.width / 2 > vw / 2;
      let x = alignRight ? a.right - w : a.left;
      x = Math.max(margin, Math.min(vw - w - margin, x));
      let y = openUp ? a.top - h - 8 : a.bottom + 8;
      y = Math.max(topLimit, Math.min(vh - h - margin, y));
      setPos((p) =>
        p && p.x === x && p.y === y
          ? p
          : { x, y, ox: alignRight ? 'right' : 'left', oy: openUp ? 'bottom' : 'top' },
      );
    };
    place();
    el.querySelector('.menu-item.checked')?.scrollIntoView({ block: 'nearest' });
    let pending = (): void => undefined;
    const schedule = (): void => {
      pending();
      pending = soon(place);
    };
    const vv = window.visualViewport;
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    if (root) ro.observe(root);
    const off = attachRefraction(el);
    const cancel = soon(() => setEntered(true));
    return () => {
      off();
      cancel();
      pending();
      ro.disconnect();
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
    };
  }, [anchor]);

  useLayerFocus(menuRef, close, (el) => {
    const items = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    return items.find((x) => x.classList.contains('checked')) ?? items[0];
  });

  /** Arrow keys, Home and End move between the items; typing a letter goes to the next that starts with it. */
  const onMenuKey = (e: KeyboardEvent): void => {
    const el = menuRef.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    const active = document.activeElement;
    const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
    let next = -1;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      const hit = order.find((x) => x.textContent.trim().toLowerCase().startsWith(k));
      if (hit) next = items.indexOf(hit);
    }
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  const state = closing ? 'out' : entered ? 'in' : 'pre';
  return (
    <div class={`menu-layer ${state}`}>
      <div
        class="menu-backdrop"
        onClick={close}
        onContextMenu={(e) => e.preventDefault()}
        aria-hidden="true"
      />
      <div
        ref={menuRef}
        class="menu glass glass-regular"
        role="menu"
        tabIndex={-1}
        onKeyDown={onMenuKey}
        data-testid={testid}
        style={
          pos
            ? { left: `${pos.x}px`, top: `${pos.y}px`, transformOrigin: `${pos.oy} ${pos.ox}` }
            : { visibility: 'hidden' }
        }
      >
        <div class="menu-scroll">
          {sections
            .filter((s) => s.items.length > 0)
            .map((s) => (
              <div class="menu-section" key={s.title ?? s.items[0]?.label}>
                {s.title && <div class="menu-title">{s.title}</div>}
                {s.items.map((it) => (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    class={`menu-item ${it.destructive ? 'destructive' : ''} ${it.checked ? 'checked' : ''} ${it.dim ? 'dim' : ''} ${it.lead ? 'has-lead' : ''}`}
                    disabled={it.disabled}
                    data-testid={it.testid}
                    onClick={() => {
                      haptic('light');
                      close();
                      it.onSelect();
                    }}
                  >
                    {it.lead ? (
                      <span class="menu-lead">{it.lead}</span>
                    ) : (
                      <span class="menu-check">
                        {it.checked && <Icon name="check" size={16} stroke={2.4} />}
                      </span>
                    )}
                    <span class="menu-label">
                      {it.label}
                      {it.hint && <small>{it.hint}</small>}
                    </span>
                    {it.lead && it.checked ? (
                      <Icon name="check" size={17} stroke={2.4} />
                    ) : (
                      it.icon && <Icon name={it.icon} size={19} />
                    )}
                  </button>
                ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ alerts

interface AlertOpts {
  title: string;
  message?: string;
  confirm: string;
  cancel?: string;
  destructive?: boolean;
  /** Show a text field; the promise resolves with its value. */
  input?: { value?: string; placeholder?: string };
  testid?: string;
}

/** iOS-style alert. Resolves true/false, or the entered text (null when cancelled). */
export function alertDialog(opts: AlertOpts & { input: AlertOpts['input'] & object }): Promise<string | null>;
export function alertDialog(opts: AlertOpts): Promise<boolean>;
export function alertDialog(opts: AlertOpts): Promise<boolean | string | null> {
  return new Promise((resolve) => {
    let result: boolean | string | null = opts.input ? null : false;
    addLayer(
      (close, closing) => (
        <Alert
          opts={opts}
          closing={closing}
          done={(r) => {
            result = r;
            close();
          }}
        />
      ),
      () => resolve(result),
    );
  });
}

function Alert({
  opts,
  closing,
  done,
}: {
  opts: AlertOpts;
  closing: boolean;
  done: (r: boolean | string | null) => void;
}): JSX.Element {
  const [entered, setEntered] = useState(false);
  const [value, setValue] = useState(opts.input?.value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const cancel = soon(() => setEntered(true));
    if (opts.input) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    return cancel;
  }, [opts.input]);
  const cancel = (): void => done(opts.input ? null : false);
  const ok = (): void => done(opts.input ? value.trim() || null : true);
  const alertRef = useRef<HTMLDivElement>(null);
  // The field when there is one, else the confirming button (Cancel when confirming would
  // destroy something): Return answers, Escape cancels.
  useLayerFocus(alertRef, cancel, (el) =>
    opts.input
      ? null
      : el.querySelector<HTMLElement>(opts.destructive ? '.alert-btn:not(.strong)' : '.alert-btn.strong'),
  );
  return (
    <div class={`alert-layer ${closing ? 'out' : entered ? 'in' : 'pre'}`}>
      <div class="alert-backdrop" aria-hidden="true" onClick={cancel} />
      <div
        ref={alertRef}
        class="alert glass glass-regular"
        role="alertdialog"
        aria-label={opts.title}
        data-testid={opts.testid}
      >
        <div class="alert-body">
          <h2>{opts.title}</h2>
          {opts.message && <p>{opts.message}</p>}
          {opts.input && (
            <input
              ref={inputRef}
              class="alert-input"
              value={value}
              placeholder={opts.input.placeholder}
              aria-label={opts.title}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ok();
              }}
              data-testid={opts.testid ? `${opts.testid}-input` : undefined}
            />
          )}
        </div>
        <div class="alert-actions">
          <button type="button" class="alert-btn" onClick={cancel}>
            {opts.cancel ?? 'Cancel'}
          </button>
          <button
            type="button"
            class={`alert-btn strong ${opts.destructive ? 'destructive' : ''}`}
            onClick={ok}
            data-testid={opts.testid ? `${opts.testid}-confirm` : undefined}
          >
            {opts.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toast

interface ToastAction {
  label: string;
  run: () => void;
  testid?: string;
}

const toastMsg = signal<{ text: string; icon?: IconName; action?: ToastAction; n: number } | null>(null);
let toastTimer: number | undefined;

/** A short note at the bottom; with an action (Undo) it stays a little longer. */
export function toast(text: string, icon?: IconName, opts: { action?: ToastAction } = {}): void {
  toastMsg.value = { text, icon, action: opts.action, n: (toastMsg.value?.n ?? 0) + 1 };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => {
      toastMsg.value = null;
    },
    opts.action ? 4500 : 1800,
  );
}

function ToastHost(): JSX.Element | null {
  const t = toastMsg.value;
  if (!t) return null;
  return (
    <output class={`toast glass glass-regular ${t.action ? 'has-action' : ''}`} key={t.n} data-testid="toast">
      {t.icon && <Icon name={t.icon} size={17} stroke={2.2} />}
      {t.text}
      {t.action && (
        <button
          type="button"
          class="toast-action"
          data-testid={t.action.testid}
          onClick={() => {
            const run = t.action?.run;
            toastMsg.value = null;
            clearTimeout(toastTimer);
            run?.();
          }}
        >
          {t.action.label}
        </button>
      )}
    </output>
  );
}
