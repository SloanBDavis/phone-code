import type { ComponentChildren, JSX } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { attachRefraction } from '../lib/glass';
import { haptic, reducedMotion } from '../lib/util';
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

function LayerCtx({ layer }: { layer: Layer }): JSX.Element {
  useEffect(() => {
    if (!layer.closing) return;
    const t = setTimeout(() => removeLayer(layer.id), reducedMotion() ? 10 : ANIM_MS);
    return () => clearTimeout(t);
  }, [layer.closing, layer.id]);
  return <>{layer.render(() => closeLayer(layer.id), layer.closing)}</>;
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
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const dragRef = useRef<{
    y0: number;
    t0: number;
    dy: number;
    active: boolean;
    scroller: HTMLElement | null;
  } | null>(null);

  useLayoutEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close]);

  const setY = (y: number, animate: boolean): void => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? '' : 'none';
    el.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [data-nodrag]')) return;
    const scroller = target.closest<HTMLElement>('.sheet-scroll');
    dragRef.current = { y0: e.clientY, t0: performance.now(), dy: 0, active: false, scroller };
  };
  const onPointerMove = (e: PointerEvent): void => {
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
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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

  const state = closing ? 'out' : entered ? 'in' : 'pre';
  return (
    <div class={`sheet-layer ${state}`}>
      <div class="sheet-backdrop" onClick={close} aria-hidden="true" />
      <div
        ref={ref}
        class={`sheet glass glass-regular ${opts.large ? 'sheet-large' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={opts.label}
        data-testid={opts.testid}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div class="sheet-grabber" aria-hidden="true" />
        {children}
      </div>
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
  onSelect: () => void;
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

/** Opens a glass context menu anchored to an element. */
export function openMenu(anchor: Element, sections: MenuSection[], opts: { testid?: string } = {}): void {
  const rect = anchor.getBoundingClientRect();
  haptic('light');
  addLayer((close, closing) => (
    <Menu rect={rect} sections={sections} close={close} closing={closing} testid={opts.testid} />
  ));
}

function Menu({
  rect,
  sections,
  close,
  closing,
  testid,
}: {
  rect: DOMRect;
  sections: MenuSection[];
  close: () => void;
  closing: boolean;
  testid?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; ox: string; oy: string } | null>(null);
  const [entered, setEntered] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.querySelector<HTMLElement>('.app');
    const app = root?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const vw = app.width;
    const vh = app.height;
    const a = {
      left: rect.left - app.left,
      right: rect.right - app.left,
      top: rect.top - app.top,
      bottom: rect.bottom - app.top,
    };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 10;
    const openUp = a.bottom + h + margin > vh && a.top - h - margin > 0;
    const alignRight = a.left + rect.width / 2 > vw / 2;
    let x = alignRight ? a.right - w : a.left;
    x = Math.max(margin, Math.min(vw - w - margin, x));
    let y = openUp ? a.top - h - 8 : a.bottom + 8;
    y = Math.max(margin + 40, Math.min(vh - h - margin, y));
    setPos({ x, y, ox: alignRight ? 'right' : 'left', oy: openUp ? 'bottom' : 'top' });
    const off = attachRefraction(el);
    const r = requestAnimationFrame(() => setEntered(true));
    return () => {
      off();
      cancelAnimationFrame(r);
    };
  }, [rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close]);

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
        ref={ref}
        class="menu glass glass-regular"
        role="menu"
        data-testid={testid}
        style={
          pos
            ? { left: `${pos.x}px`, top: `${pos.y}px`, transformOrigin: `${pos.oy} ${pos.ox}` }
            : { visibility: 'hidden' }
        }
      >
        {sections.map((s, si) => (
          <div class="menu-section" key={si}>
            {s.title && <div class="menu-title">{s.title}</div>}
            {s.items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                class={`menu-item ${it.destructive ? 'destructive' : ''}`}
                disabled={it.disabled}
                data-testid={it.testid}
                onClick={() => {
                  haptic('light');
                  close();
                  it.onSelect();
                }}
              >
                <span class="menu-check">{it.checked && <Icon name="check" size={16} stroke={2.4} />}</span>
                <span class="menu-label">
                  {it.label}
                  {it.hint && <small>{it.hint}</small>}
                </span>
                {it.icon && <Icon name={it.icon} size={19} />}
              </button>
            ))}
          </div>
        ))}
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
    const r = requestAnimationFrame(() => setEntered(true));
    if (opts.input) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    return () => cancelAnimationFrame(r);
  }, [opts.input]);
  const cancel = (): void => done(opts.input ? null : false);
  const ok = (): void => done(opts.input ? value.trim() || null : true);
  return (
    <div class={`alert-layer ${closing ? 'out' : entered ? 'in' : 'pre'}`}>
      <div class="alert-backdrop" aria-hidden="true" onClick={cancel} />
      <div
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

const toastMsg = signal<{ text: string; icon?: IconName; n: number } | null>(null);
let toastTimer: number | undefined;

export function toast(text: string, icon?: IconName): void {
  toastMsg.value = { text, icon, n: (toastMsg.value?.n ?? 0) + 1 };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMsg.value = null;
  }, 1800);
}

function ToastHost(): JSX.Element | null {
  const t = toastMsg.value;
  if (!t) return null;
  return (
    <div class="toast glass glass-regular" role="status" key={t.n} data-testid="toast">
      {t.icon && <Icon name={t.icon} size={17} stroke={2.2} />}
      {t.text}
    </div>
  );
}
