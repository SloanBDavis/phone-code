/** Small shared helpers. */

export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Abbreviates the home directory as ~. */
export function tildify(path: string, home?: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function basename(path: string): string {
  const p = path.replace(/\/+$/, '');
  return p.slice(p.lastIndexOf('/') + 1) || p;
}

/**
 * Haptic-like feedback. iOS Safari has no vibration API; iOS 18 gives a real
 * haptic tick when a native `<input type=checkbox switch>` toggles, which we
 * trigger through a hidden one. Elsewhere `navigator.vibrate` is used.
 */
let hapticEl: HTMLLabelElement | null = null;
export function haptic(kind: 'light' | 'medium' | 'success' | 'warning' = 'light'): void {
  try {
    if ('vibrate' in navigator && !/iPhone|iPad/.test(navigator.userAgent)) {
      navigator.vibrate(kind === 'light' ? 8 : kind === 'medium' ? 14 : [10, 40, 14]);
      return;
    }
    if (!hapticEl) {
      hapticEl = document.createElement('label');
      hapticEl.ariaHidden = 'true';
      hapticEl.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticEl.appendChild(input);
      document.body.appendChild(hapticEl);
    }
    hapticEl.click();
  } catch {
    // no haptics available
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export const isIOS = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
