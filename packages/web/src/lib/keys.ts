/** Keyboard helpers: the platform's command key, and whether a key press is typing. */

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';
export const ALT = isMac ? '⌥' : 'Alt';
export const SHIFT = isMac ? '⇧' : 'Shift';

/** A key press aimed at a text field (or the terminal): letters and digits there are text. */
export function isTyping(e: Event): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.matches('input, textarea, select') || t.closest('.xterm') !== null;
}

/** The command key (and only it, with `shift`/`alt` exactly as asked). */
export function withMod(e: KeyboardEvent, { shift = false, alt = false } = {}): boolean {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.shiftKey === shift && e.altKey === alt;
}

/** No modifier at all (Shift allowed when `shift`). */
export function plain(e: KeyboardEvent, { shift = false } = {}): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && (shift || !e.shiftKey);
}

/** The letter or digit pressed, from its physical key: ⌥ on a Mac changes `e.key` ("∂" for ⌥D). */
export function keyOf(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return e.key;
}

/**
 * ↑ ↓ Home End between the items of a list (the elements matching `selector` under
 * `root`). ↑ on the first item goes to `above`, when there is one (the search field).
 * Returns whether it moved.
 */
export function moveInList(
  e: KeyboardEvent,
  root: ParentNode,
  selector: string,
  above?: HTMLElement | null,
): boolean {
  if (e.altKey || e.metaKey || e.ctrlKey) return false;
  const items = [...root.querySelectorAll<HTMLElement>(selector)];
  const cur = e.currentTarget;
  const at = cur instanceof HTMLElement ? items.indexOf(cur) : -1;
  let next: HTMLElement | null | undefined;
  if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, at + 1)];
  else if (e.key === 'ArrowUp') next = at <= 0 ? above : items[at - 1];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items.at(-1);
  else return false;
  e.preventDefault();
  next?.focus();
  return true;
}
