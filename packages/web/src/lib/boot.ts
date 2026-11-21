import { signal } from '@preact/signals';
import { forgetDevice, handoff, pair } from './api';
import { client } from './client';
import { creds } from './storage';
import { isIOS, isStandalone } from './util';
import { WsTransport } from './ws';

/**
 * pair     pairing flow (scan / paste / auto-pair from a code)
 * install  just paired in iOS Safari: coach "Add to Home Screen"
 * app      sessions UI (connected to a host or the demo)
 */
export type Mode = 'pair' | 'install' | 'app';

export const mode = signal<Mode>('pair');
/** Code to redeem automatically when the pairing screen opens. */
export const autoCode = signal<string | null>(null);
/** Why we are on the pairing screen, if not by choice (e.g. unpaired by the host). */
export const pairReason = signal<string | null>(null);
export const handoffCode = signal<string | null>(null);

export function readLaunchParams(): { demo: boolean; pairCode: string | null; handoff: string | null } {
  const q = new URLSearchParams(location.search);
  const hash = location.hash;
  let pairCode: string | null = null;
  if (hash.startsWith('#/pair')) {
    const i = hash.indexOf('?');
    pairCode = i >= 0 ? new URLSearchParams(hash.slice(i + 1)).get('c') : null;
  }
  return { demo: q.has('demo'), pairCode, handoff: q.get('h') };
}

export function startHost(): void {
  const c = creds.value;
  if (!c) return;
  client.start(new WsTransport(c.token));
  mode.value = 'app';
  void refreshHandoff();
}

export async function startDemo(): Promise<void> {
  const { DemoTransport } = await import('./demo/demo');
  client.start(new DemoTransport());
  const u = new URL(location.href);
  if (!u.searchParams.has('demo')) {
    u.searchParams.set('demo', '1');
    u.searchParams.delete('h');
    u.hash = '#/';
    history.replaceState(null, '', u);
  }
  mode.value = 'app';
}

export function exitDemo(): void {
  client.stop();
  const u = new URL(location.href);
  u.searchParams.delete('demo');
  u.hash = '#/';
  history.replaceState(null, '', u);
  if (creds.value) startHost();
  else mode.value = 'pair';
}

/** Redeems a pairing or handoff code. Throws ApiError on failure. */
export async function redeem(code: string): Promise<void> {
  const res = await pair(code);
  creds.value = { ...res, pairedAt: Date.now() };
  pairReason.value = null;
  // Spent: never redeem it again (e.g. when this phone is unpaired later).
  autoCode.value = null;
  const u = new URL(location.href);
  u.hash = '#/';
  u.searchParams.delete('h');
  history.replaceState(null, '', u);
  client.start(new WsTransport(res.token));
  if (isIOS() && !isStandalone()) {
    await refreshHandoff();
    mode.value = 'install';
  } else mode.value = 'app';
}

/**
 * iOS gives the Home Screen app its own storage. Mint a single-use code and
 * bake it into the manifest start_url and the current URL, so the installed
 * app can pair itself on first launch.
 */
export async function refreshHandoff(): Promise<void> {
  const c = creds.value;
  if (!c || !isIOS() || isStandalone()) return;
  try {
    const { code } = await handoff(c.token);
    handoffCode.value = code;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.href = `/manifest.webmanifest?h=${encodeURIComponent(code)}`;
    const u = new URL(location.href);
    u.searchParams.set('h', code);
    history.replaceState(history.state, '', u);
  } catch {
    // Older daemon or offline: the user can still pair the installed app by scanning.
  }
}

/** The user unpairs this phone: the host forgets it too (best effort, e.g. when offline). */
export function unpairDevice(): void {
  const token = creds.value?.token;
  if (token) void forgetDevice(token).catch(() => undefined);
  unpair();
}

export function unpair(reason?: string): void {
  client.stop();
  creds.value = null;
  autoCode.value = null;
  pairReason.value = reason ?? null;
  const u = new URL(location.href);
  u.search = '';
  u.hash = '#/';
  history.replaceState(null, '', u);
  mode.value = 'pair';
}
