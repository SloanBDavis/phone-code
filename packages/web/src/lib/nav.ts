import { batch, signal } from '@preact/signals';
import { reducedMotion } from './util';

export type Route = { name: 'home' } | { name: 'session'; id: string } | { name: 'settings' };

export interface Entry {
  key: number;
  route: Route;
}

export type NavAnim = 'push' | 'pop' | 'pop-done' | 'none';

let nextKey = 1;

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'session':
      return `#/s/${encodeURIComponent(r.id)}`;
    case 'settings':
      return '#/settings';
    default: {
      const never: never = r;
      return never;
    }
  }
}

export function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, '').split('?')[0] ?? '';
  if (path === '' || path === '/') return { name: 'home' };
  if (path === '/settings') return { name: 'settings' };
  const m = /^\/s\/(.+)$/.exec(path);
  if (m?.[1]) return { name: 'session', id: decodeURIComponent(m[1]) };
  return null;
}

const same = (a: Route, b: Route): boolean => routeHash(a) === routeHash(b);

/** The navigation stack, synced with history so the hardware/browser back works. */
export const stack = signal<Entry[]>([{ key: 0, route: { name: 'home' } }]);
/** How the latest stack change should be animated. */
export const lastAnim = signal<NavAnim>('none');
/** A popped entry kept on screen while its exit animation runs. */
export const leaving = signal<Entry | null>(null);

let started = false;
/** Set when the UI already animated a pop (swipe-back) before history caught up. */
let popAnimated = false;

export function startNav(): void {
  if (started) return;
  started = true;
  const r = parseHash(location.hash);
  if (r && r.name !== 'home') {
    // Deep link: put home underneath so "back" stays inside the app.
    history.replaceState(history.state, '', `${location.pathname}${location.search}#/`);
    history.pushState(null, '', `${location.pathname}${location.search}${routeHash(r)}`);
    stack.value = [
      { key: 0, route: { name: 'home' } },
      { key: nextKey++, route: r },
    ];
  }
  addEventListener('hashchange', onHashChange);
}

function onHashChange(): void {
  const r = parseHash(location.hash);
  if (!r) return;
  const s = stack.value;
  const top = s[s.length - 1];
  if (top && same(top.route, r)) return;
  const idx = s.findLastIndex((e) => same(e.route, r));
  if (idx >= 0) {
    batch(() => {
      lastAnim.value = popAnimated ? 'pop-done' : 'pop';
      leaving.value = popAnimated || reducedMotion() ? null : (top ?? null);
      stack.value = s.slice(0, idx + 1);
    });
    popAnimated = false;
    return;
  }
  batch(() => {
    lastAnim.value = 'push';
    leaving.value = null;
    stack.value = [...s, { key: nextKey++, route: r }];
  });
}

export function push(r: Route): void {
  const top = stack.value[stack.value.length - 1];
  if (top && same(top.route, r)) return;
  location.hash = routeHash(r);
}

export function pop(alreadyAnimated = false): void {
  if (stack.value.length < 2) return;
  popAnimated = alreadyAnimated;
  history.back();
}

/** Go back to the root (e.g. after deleting the open session). */
export function popToRoot(): void {
  const n = stack.value.length - 1;
  if (n > 0) history.go(-n);
}
