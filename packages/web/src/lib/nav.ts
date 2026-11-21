import { signal } from '@preact/signals';
import { isString } from './guards';
import { load, save } from './storage';

/**
 * Where the main pane is: a new, not yet created chat, or a session (chat or
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

const LAST = 'pc.lastChat';

export const route = signal<Route>({ name: 'new' });

let started = false;

/**
 * Launch opens the chat that was open last time (or a new chat). Switching
 * chats replaces the history entry, so the browser's back button does not
 * walk through every chat ever opened.
 */
export function startNav(): void {
  if (started) return;
  started = true;
  let r = parseHash(location.hash) ?? { name: 'new' };
  if (r.name === 'new' && (location.hash === '' || location.hash === '#/')) {
    const last = load<string | null>(LAST, null, (v): v is string | null => v === null || isString(v));
    if (last) r = { name: 'session', id: last };
  }
  set(r);
  addEventListener('hashchange', () => {
    const next = parseHash(location.hash);
    if (next && routeHash(next) !== routeHash(route.peek())) set(next, false);
  });
}

function set(r: Route, write = true): void {
  route.value = r;
  save(LAST, r.name === 'session' ? r.id : null);
  if (write && location.hash !== routeHash(r))
    history.replaceState(history.state, '', `${location.pathname}${location.search}${routeHash(r)}`);
}

export function openChat(id: string): void {
  set({ name: 'session', id });
}

export function openNew(): void {
  set({ name: 'new' });
}

export const currentSessionId = (): string | null => {
  const r = route.value;
  return r.name === 'session' ? r.id : null;
};
