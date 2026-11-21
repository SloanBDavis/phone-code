import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import '../styles/viewer.css';
import { picUrl, type Pic } from '../lib/images';
import { haptic, soon } from '../lib/util';
import { GlassButton } from '../ui/glass';
import { Spinner } from '../ui/icons';
import { toast } from '../ui/overlay';

interface Zoom {
  s: number;
  x: number;
  y: number;
}

type Mode = 'idle' | 'pending' | 'swipe' | 'dismiss' | 'pan' | 'pinch';

interface Gesture {
  mode: Mode;
  x0: number;
  y0: number;
  t0: number;
  /** Last point and time, for the release velocity. */
  x: number;
  y: number;
  t: number;
  vx: number;
  vy: number;
  zoom0: Zoom;
  /** Pinch: distance and midpoint when the second finger came down. */
  d0: number;
  m0: { x: number; y: number };
  watchdog: number;
}

const MAX_ZOOM = 5;
const DOUBLE_ZOOM = 2.5;
const WATCHDOG_MS = 2500;

function FullImage({ pic, near }: { pic: Pic; near: boolean }): JSX.Element {
  const [url, setUrl] = useState<string | null>(pic.src ?? null);
  useEffect(() => {
    if (!near || url) return undefined;
    let alive = true;
    picUrl(pic).then(
      (u) => alive && setUrl(u),
      () => alive && setUrl('error'),
    );
    return () => {
      alive = false;
    };
  }, [near, pic.key]);
  if (url === 'error') return <p class="viewer-missing">This image is not available.</p>;
  if (!url) return <Spinner size={26} />;
  return <img class="viewer-img" src={url} alt={pic.name ?? ''} draggable={false} />;
}

/**
 * Full-screen image viewer: pinch and double-tap to zoom, swipe sideways
 * between images, swipe down to dismiss, Share/Save. Like the drawer, every
 * gesture settles on any end or cancel (and a watchdog), the final state is
 * applied at once, and transitions only decorate the way there.
 */
export default function Viewer({
  pics,
  start,
  close,
  closing,
}: {
  pics: Pic[];
  start: number;
  close: () => void;
  closing: boolean;
}): JSX.Element {
  const [index, setIndex] = useState(Math.max(0, Math.min(pics.length - 1, start)));
  const [entered, setEntered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<Zoom>({ s: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gRef = useRef<Gesture | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  useLayoutEffect(() => soon(() => setEntered(true)), []);

  const el = (): { root?: HTMLElement; track?: HTMLElement; img?: HTMLElement; bg?: HTMLElement } => {
    const root = rootRef.current ?? undefined;
    return {
      root,
      track: trackRef.current ?? undefined,
      img: root?.querySelector<HTMLElement>(`.viewer-slide[data-i="${indexRef.current}"] .viewer-zoom`) ?? undefined,
      bg: root?.querySelector<HTMLElement>('.viewer-bg') ?? undefined,
    };
  };

  const paint = (dx = 0, dy = 0): void => {
    const { root, track, img, bg } = el();
    const z = zoomRef.current;
    if (root) root.dataset['zoomed'] = String(z.s > 1);
    if (track) track.style.transform = `translate3d(calc(${-indexRef.current * 100}% + ${dx}px),0,0)`;
    if (img) img.style.transform = `translate3d(${z.x}px,${z.y + dy}px,0) scale(${z.s})`;
    if (bg) bg.style.opacity = String(Math.max(0, 1 - Math.abs(dy) / 420));
  };

  /** Keeps a zoomed image covering the screen where it can, centred where it cannot. */
  const clamp = (z: Zoom): Zoom => {
    const { root, img } = el();
    const s = Math.max(1, Math.min(MAX_ZOOM, z.s));
    if (s === 1 || !root || !img) return { s, x: 0, y: 0 };
    const pic = img.querySelector('img');
    const w = (pic?.clientWidth ?? root.clientWidth) * s;
    const h = (pic?.clientHeight ?? root.clientHeight) * s;
    const mx = Math.max(0, (w - root.clientWidth) / 2);
    const my = Math.max(0, (h - root.clientHeight) / 2);
    return { s, x: Math.max(-mx, Math.min(mx, z.x)), y: Math.max(-my, Math.min(my, z.y)) };
  };

  /** The settled state, applied now; the stylesheet's transitions animate there. */
  const settleTo = (z: Zoom, i = indexRef.current): void => {
    zoomRef.current = z;
    indexRef.current = i;
    rootRef.current?.classList.remove('dragging');
    paint();
    if (i !== index) setIndex(i);
  };

  const go = (i: number): void => {
    if (i < 0 || i >= pics.length) return;
    haptic('light');
    settleTo({ s: 1, x: 0, y: 0 }, i);
  };

  const center = (x: number, y: number): { x: number; y: number } => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 } : { x, y };
  };

  const end = (): void => {
    const g = gRef.current;
    pointers.current.clear();
    if (!g) return;
    gRef.current = null;
    clearTimeout(g.watchdog);
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    const recent = performance.now() - g.t < 120;
    const vx = recent ? g.vx : 0;
    const vy = recent ? g.vy : 0;
    const w = rootRef.current?.clientWidth ?? innerWidth;
    switch (g.mode) {
      case 'swipe': {
        const i = indexRef.current;
        const next =
          (dx < -w * 0.22 || vx < -0.4) && i < pics.length - 1
            ? i + 1
            : (dx > w * 0.22 || vx > 0.4) && i > 0
              ? i - 1
              : i;
        if (next !== i) haptic('light');
        settleTo({ s: 1, x: 0, y: 0 }, next);
        return;
      }
      case 'dismiss':
        if (dy > 120 || vy > 0.6) {
          haptic('light');
          // Keep it where the finger left it while the layer fades out.
          rootRef.current?.classList.add('dismissing');
          close();
        } else settleTo(zoomRef.current);
        return;
      case 'pan':
      case 'pinch':
        settleTo(clamp(zoomRef.current));
        return;
      case 'pending':
      case 'idle': {
        // A tap: two of them close together zoom in (on that spot) or back out.
        const now = performance.now();
        const lt = lastTap.current;
        if (now - g.t0 < 300 && Math.hypot(dx, dy) < 10) {
          if (lt && now - lt.t < 320 && Math.hypot(g.x - lt.x, g.y - lt.y) < 30) {
            lastTap.current = null;
            const z = zoomRef.current;
            if (z.s > 1) settleTo({ s: 1, x: 0, y: 0 });
            else {
              const p = center(g.x, g.y);
              settleTo(clamp({ s: DOUBLE_ZOOM, x: p.x * (1 - DOUBLE_ZOOM), y: p.y * (1 - DOUBLE_ZOOM) }));
            }
            return;
          }
          lastTap.current = { t: now, x: g.x, y: g.y };
        }
        settleTo(zoomRef.current);
        return;
      }
      default: {
        const never: never = g.mode;
        return never;
      }
    }
  };

  const endRef = useRef(end);
  useLayoutEffect(() => {
    endRef.current = end;
  });

  useEffect(() => {
    const onEnd = (e: Event): void => {
      // A finger lifting while another stays down is not the end of a pinch.
      if (e.type === 'pointerup' && pointers.current.size > 1 && e instanceof PointerEvent) {
        pointers.current.delete(e.pointerId);
        return;
      }
      if (e.type === 'touchend' && e instanceof TouchEvent && e.touches.length > 0) return;
      endRef.current();
    };
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') endRef.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') goRef.current(indexRef.current + 1);
      else if (e.key === 'ArrowLeft') goRef.current(indexRef.current - 1);
    };
    const opts = { capture: true, passive: true };
    const types = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const;
    for (const t of types) addEventListener(t, onEnd, opts);
    addEventListener('blur', onHidden);
    addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      for (const t of types) removeEventListener(t, onEnd, opts);
      removeEventListener('blur', onHidden);
      removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHidden);
      const g = gRef.current;
      if (g) clearTimeout(g.watchdog);
    };
  }, []);
  const goRef = useRef(go);
  goRef.current = go;

  // The track follows the index (taps on arrows, keys) as well as gestures.
  useLayoutEffect(() => paint(), [index]);

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('.viewer-bar')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      if (e.currentTarget instanceof Element) e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // the window listeners still see the release
    }
    const now = performance.now();
    const g = gRef.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const base = g ?? null;
      if (base) clearTimeout(base.watchdog);
      gRef.current = {
        mode: 'pinch',
        x0: e.clientX,
        y0: e.clientY,
        t0: now,
        x: e.clientX,
        y: e.clientY,
        t: now,
        vx: 0,
        vy: 0,
        zoom0: { ...zoomRef.current },
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        m0: center((a.x + b.x) / 2, (a.y + b.y) / 2),
        watchdog: window.setTimeout(() => endRef.current(), WATCHDOG_MS),
      };
      rootRef.current?.classList.add('dragging');
      return;
    }
    if (g) return;
    gRef.current = {
      mode: 'pending',
      x0: e.clientX,
      y0: e.clientY,
      t0: now,
      x: e.clientX,
      y: e.clientY,
      t: now,
      vx: 0,
      vy: 0,
      zoom0: { ...zoomRef.current },
      d0: 0,
      m0: { x: 0, y: 0 },
      watchdog: window.setTimeout(() => endRef.current(), WATCHDOG_MS),
    };
  };

  const onMove = (e: PointerEvent): void => {
    const g = gRef.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    const dt = Math.max(1, now - g.t);
    g.vx = 0.7 * ((e.clientX - g.x) / dt) + 0.3 * g.vx;
    g.vy = 0.7 * ((e.clientY - g.y) / dt) + 0.3 * g.vy;
    g.x = e.clientX;
    g.y = e.clientY;
    g.t = now;
    clearTimeout(g.watchdog);
    g.watchdog = window.setTimeout(() => endRef.current(), WATCHDOG_MS);
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    if (g.mode === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const s = Math.max(0.6, Math.min(MAX_ZOOM * 1.2, (g.zoom0.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0));
      const m = center((a.x + b.x) / 2, (a.y + b.y) / 2);
      // The point under the fingers stays under them.
      const k = s / g.zoom0.s;
      zoomRef.current = { s, x: m.x - (g.m0.x - g.zoom0.x) * k, y: m.y - (g.m0.y - g.zoom0.y) * k };
      paint();
      return;
    }
    if (g.mode === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      g.mode = zoomRef.current.s > 1 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'dismiss' : 'swipe';
      rootRef.current?.classList.add('dragging');
    }
    if (g.mode === 'swipe') {
      const i = indexRef.current;
      // Rubber band past the first and last image.
      const edge = (dx > 0 && i === 0) || (dx < 0 && i === pics.length - 1);
      paint(edge ? dx / 3 : dx);
    } else if (g.mode === 'dismiss') paint(0, Math.max(0, dy));
    else if (g.mode === 'pan') {
      zoomRef.current = { ...g.zoom0, x: g.zoom0.x + dx, y: g.zoom0.y + dy };
      paint();
    }
  };

  const share = async (): Promise<void> => {
    const pic = pics[indexRef.current];
    if (!pic) return;
    try {
      const url = await picUrl(pic);
      const blob = await (await fetch(url)).blob();
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const name = pic.name ?? `image-${indexRef.current + 1}.${ext}`;
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      toast('Could not share this image', 'warn');
    }
  };
  const canShare = typeof navigator.share === 'function';

  return (
    <div
      ref={rootRef}
      class={`viewer ${closing ? 'out' : entered ? 'in' : 'pre'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      data-testid="image-viewer"
      data-index={index}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onLostPointerCapture={(e) => {
        if (e.target === e.currentTarget && pointers.current.size <= 1) end();
      }}
    >
      <div class="viewer-bg" />
      <div class="viewer-track" ref={trackRef}>
        {pics.map((p, i) => (
          <div class="viewer-slide" data-i={i} key={p.key}>
            <div class="viewer-zoom">
              <FullImage pic={p} near={Math.abs(i - index) <= 1} />
            </div>
          </div>
        ))}
      </div>
      <div class="viewer-bar">
        <GlassButton icon="close" label="Close" onClick={close} testid="viewer-close" />
        <span class="viewer-count glass glass-regular" data-testid="viewer-count">
          {index + 1} of {pics.length}
        </span>
        <GlassButton
          icon={canShare ? 'share' : 'download'}
          label={canShare ? 'Share' : 'Save'}
          onClick={() => void share()}
          testid="viewer-share"
        />
      </div>
    </div>
  );
}
