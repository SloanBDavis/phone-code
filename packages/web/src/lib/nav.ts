import { computed, signal } from '@preact/signals';
import { isString, isStringArray } from './guards';
import { load, save } from './storage';

/**
 * Where a pane is: a new, not yet created chat, or a session (chat or
 * terminal). There is no stack: the sidebar switches between chats, so a
 * switch replaces the route instead of pushing a screen.
 */
export type Route = { name: 'new' } | { name: 'session'; id: string };

export function routeHash(r: Route): string {
  return r.name === 'new' ? '#/' : `#/s/${encodeURIComponent(r.id)}`;
}

export function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, '').split('?')[0] ?? '';
  if (path === '' || path === '/') return { name: 'new' };
  const m = /^\/s\/(.+)$/.exec(path);
  if (m?.[1]) return { name: 'session', id: decodeURIComponent(m[1]) };
  return null;
}

/**
 * The main area is one pane, or on a wide screen several side by side
 * (tiles). One of them is the focused pane: the sidebar opens chats in it,
 * and it is what the address shows. `k` keeps a pane's screen the same
 * instance while its route changes (a new chat becoming its session).
 */
export interface Pane {
  k: number;
  r: Route;
}

export const MAX_PANES = 4;
const LAST = 'pc.lastChat';
const PANES = 'pc.panes';
const FOCUS = 'pc.paneFocus';
const NEW: Route = { name: 'new' };

let nextKey = 1;
const pane = (r: Route): Pane => ({ k: nextKey++, r });
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const same = (a: Route, b: Route): boolean => routeHash(a) === routeHash(b);

export const panes = signal<Pane[]>([pane(NEW)]);
export const focused = signal(0);
/** The focused pane's route. */
export const route = computed<Route>(() => panes.value[focused.value]?.r ?? NEW);

let started = false;

function commit(next: Pane[], focus: number, write = true): void {
  const list = next.length > 0 ? next : [pane(NEW)];
  const f = Math.max(0, Math.min(list.length - 1, focus));
  panes.value = list;
  focused.value = f;
  const r = list[f]?.r ?? NEW;
  save(LAST, r.name === 'session' ? r.id : null);
  save(
    PANES,
    list.map((p) => routeHash(p.r)),
  );
  save(FOCUS, f);
  if (write && started && location.hash !== routeHash(r))
    history.replaceState(history.state, '', `${location.pathname}${location.search}${routeHash(r)}`);
}

/**
 * Launch opens what was open last time (or a new chat). Switching chats
 * replaces the history entry, so the browser's back button does not walk
 * through every chat ever opened.
 */
export function startNav(): void {
  if (started) return;
  started = true;
  const saved = load<string[]>(PANES, [], isStringArray)
    .map(parseHash)
    .filter((r): r is Route => r !== null)
    .filter((r, i, all) => all.findIndex((x) => same(x, r)) === i)
    .slice(0, MAX_PANES);
  const fromHash = parseHash(location.hash) ?? NEW;
  const bare = location.hash === '' || location.hash === '#/';
  if (saved.length > 1) {
    const list = saved.map(pane);
    const at = list.findIndex((p) => same(p.r, fromHash));
    const f = load(FOCUS, 0, isNumber);
    if (bare || at >= 0) commit(list, at >= 0 && !bare ? at : f);
    else commit([pane(fromHash)], 0);
  } else {
    let r = fromHash;
    if (r.name === 'new' && bare) {
      const last = load<string | null>(LAST, null, (v): v is string | null => v === null || isString(v));
      if (last) r = { name: 'session', id: last };
    }
    commit([pane(r)], 0);
  }
  addEventListener('hashchange', () => {
    const next = parseHash(location.hash);
    if (next && !same(next, route.peek())) show(next, false);
  });
}

/** In the focused pane, or the pane that already shows it. */
function show(r: Route, write = true): void {
  const list = panes.peek();
  const at = list.findIndex((p) => same(p.r, r));
  if (at >= 0) return commit(list, at, write);
  const f = focused.peek();
  commit(
    list.map((p, i) => (i === f ? { k: p.k, r } : p)),
    f,
    write,
  );
}

export function openChat(id: string): void {
  show({ name: 'session', id });
}

export function openNew(): void {
  show(NEW);
}

/**
 * A chat that was just started from a new-chat pane: that pane becomes it,
 * whichever pane is focused by now.
 */
export function openStarted(id: string): void {
  const list = panes.peek();
  const at = list.findIndex((p) => p.r.name === 'new');
  if (at < 0 || list.some((p) => p.r.name === 'session' && p.r.id === id)) return openChat(id);
  commit(
    list.map((p, i) => (i === at ? { k: p.k, r: { name: 'session', id } } : p)),
    at,
  );
}

/**
 * Beside the others, in a pane of its own (after `after`, or the focused
 * pane). With every pane taken, it replaces the focused one.
 */
export function openBeside(r: Route, after = focused.peek()): void {
  const list = panes.peek();
  const at = list.findIndex((p) => same(p.r, r));
  if (at >= 0) return commit(list, at);
  if (list.length >= MAX_PANES) return show(r);
  const i = Math.max(0, Math.min(list.length, after + 1));
  commit([...list.slice(0, i), pane(r), ...list.slice(i)], i);
}

export function focusPane(k: number): void {
  const at = panes.peek().findIndex((p) => p.k === k);
  if (at >= 0 && at !== focused.peek()) commit(panes.peek(), at);
}

export function closePane(k: number): void {
  const list = panes.peek();
  const at = list.findIndex((p) => p.k === k);
  if (at < 0) return;
  if (list.length === 1) return commit([{ k, r: NEW }], 0);
  const f = focused.peek();
  commit(
    list.filter((p) => p.k !== k),
    at < f ? f - 1 : Math.min(f, list.length - 2),
  );
}

/** A chat that is gone (deleted, archived): its pane closes, or the only pane goes to a new chat. */
export function closeSession(id: string): void {
  const p = panes.peek().find((x) => x.r.name === 'session' && x.r.id === id);
  if (p) closePane(p.k);
}

/** Every session that has a pane. */
export const openIds = computed(
  () => new Set(panes.value.flatMap((p) => (p.r.name === 'session' ? [p.r.id] : []))),
);
