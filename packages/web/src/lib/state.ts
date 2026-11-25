import { signal, type Signal } from '@preact/signals';
import type { ChatItem, HostInfo, SessionInfo } from '@phone-code/protocol';
import type { TransportStatus } from './transport';

/**
 * App state as signals. Each chat item lives in its own signal, so a
 * streaming delta re-renders exactly one item, never the whole transcript.
 */

export interface ConnState {
  status: TransportStatus | 'idle';
  detail?: string;
}

export const conn = signal<ConnState>({ status: 'idle' });
export const host = signal<HostInfo | null>(null);
export const deviceId = signal<string | null>(null);
export const vapidKey = signal<string | undefined>(undefined);
export const sessions = signal<SessionInfo[]>([]);
export const sessionsLoaded = signal(false);
export const isDemo = signal(false);

export interface PendingSend {
  localId: string;
  text: string;
  images: string[]; // object/data URLs for preview
  ts: number;
  status: 'sending' | 'failed';
  /** Server item id, once the daemon acknowledged the send. */
  awaitId?: string;
  /** 0..1 while photos upload. */
  progress?: number;
  /** Why the host refused it (e.g. a photo it cannot take). */
  error?: string;
}

export interface ChatState {
  sessionId: string;
  /** Top-level item ids in transcript order (sub-agent children excluded). */
  ids: Signal<string[]>;
  items: Map<string, Signal<ChatItem>>;
  kinds: Map<string, ChatItem['kind']>;
  /** Task tool id -> ids of its nested calls. */
  children: Map<string, Signal<string[]>>;
  /** Ids of permission/question items that are pending. */
  asks: Signal<string[]>;
  loaded: Signal<boolean>;
  pending: Signal<PendingSend[]>;
}

const chats = new Map<string, ChatState>();

export function chatOf(sessionId: string): ChatState {
  let c = chats.get(sessionId);
  if (!c) {
    c = {
      sessionId,
      ids: signal([]),
      items: new Map(),
      kinds: new Map(),
      children: new Map(),
      asks: signal([]),
      loaded: signal(false),
      pending: signal([]),
    };
    chats.set(sessionId, c);
  }
  return c;
}

export function dropChat(sessionId: string): void {
  chats.delete(sessionId);
}

export function childrenOf(c: ChatState, parentId: string): Signal<string[]> {
  let s = c.children.get(parentId);
  if (!s) {
    s = signal([]);
    c.children.set(parentId, s);
  }
  return s;
}

function isPendingAsk(item: ChatItem): boolean {
  return (item.kind === 'permission' || item.kind === 'question') && item.status === 'pending';
}

function syncAsk(c: ChatState, item: ChatItem): void {
  if (item.kind !== 'permission' && item.kind !== 'question') return;
  const has = c.asks.value.includes(item.id);
  const want = isPendingAsk(item);
  if (want && !has) c.asks.value = [...c.asks.value, item.id];
  else if (!want && has) c.asks.value = c.asks.value.filter((x) => x !== item.id);
}

function settlePending(c: ChatState, itemId: string): void {
  const p = c.pending.value;
  if (p.some((x) => x.awaitId === itemId)) c.pending.value = p.filter((x) => x.awaitId !== itemId);
}

/** The card an item is shown inside: a sub-agent's calls and messages go under its Task. */
function parentOf(item: ChatItem): string | undefined {
  return (item.kind === 'tool' || item.kind === 'text' || item.kind === 'thinking') && item.parentId
    ? item.parentId
    : undefined;
}

export function resetChat(sessionId: string, items: ChatItem[]): void {
  const c = chatOf(sessionId);
  c.items.clear();
  c.kinds.clear();
  c.children.clear();
  const top: string[] = [];
  const asks: string[] = [];
  for (const item of items) {
    c.items.set(item.id, signal(item));
    c.kinds.set(item.id, item.kind);
    const parent = parentOf(item);
    if (parent) {
      const ch = childrenOf(c, parent);
      ch.value = [...ch.value, item.id];
    } else top.push(item.id);
    if (isPendingAsk(item)) asks.push(item.id);
  }
  c.ids.value = top;
  c.asks.value = asks;
  c.loaded.value = true;
  const known = new Set(items.map((i) => i.id));
  c.pending.value = c.pending.value.filter((p) => !(p.awaitId && known.has(p.awaitId)));
}

export function upsertItem(sessionId: string, item: ChatItem): void {
  const c = chatOf(sessionId);
  const existing = c.items.get(item.id);
  if (existing) {
    const before = existing.value;
    existing.value = item;
    // A tool row can be nested later (ACP: under the question card that stands for it).
    const from = parentOf(before);
    const to = parentOf(item);
    if (from !== to) {
      if (from === undefined) c.ids.value = c.ids.value.filter((x) => x !== item.id);
      else {
        const old = childrenOf(c, from);
        old.value = old.value.filter((x) => x !== item.id);
      }
      if (to === undefined) c.ids.value = [...c.ids.value, item.id];
      else {
        const ch = childrenOf(c, to);
        ch.value = [...ch.value, item.id];
      }
    }
  } else {
    c.items.set(item.id, signal(item));
    c.kinds.set(item.id, item.kind);
    const parent = parentOf(item);
    if (parent) {
      const ch = childrenOf(c, parent);
      ch.value = [...ch.value, item.id];
    } else {
      c.ids.value = [...c.ids.value, item.id];
    }
    if (item.kind === 'user') settlePending(c, item.id);
  }
  syncAsk(c, item);
}

export function appendDelta(sessionId: string, itemId: string, text: string): void {
  const s = chatOf(sessionId).items.get(itemId);
  if (!s) return;
  const item = s.value;
  if (item.kind === 'text' || item.kind === 'thinking') s.value = { ...item, text: item.text + text };
}

/**
 * Sessions this phone just created, by id and time. A `sessions` push sent
 * before the create (e.g. right after a reconnect) can be applied after it;
 * it must not drop the new chat out from under the user for a moment.
 */
const justCreated = new Map<string, SessionInfo>();

export function rememberCreated(s: SessionInfo): void {
  justCreated.set(s.id, s);
  if (!sessions.peek().some((x) => x.id === s.id)) sessions.value = [s, ...sessions.peek()];
}

/** The daemon's list, plus any just-created session it does not list yet (for 15 s). */
export function applySessions(list: SessionInfo[]): void {
  const now = Date.now();
  const extra: SessionInfo[] = [];
  for (const [id, s] of justCreated) {
    if (list.some((x) => x.id === id) || now - s.createdAt > 15_000) justCreated.delete(id);
    else extra.push(s);
  }
  sessions.value = extra.length ? [...extra, ...list] : list;
}

export function sessionById(id: string): SessionInfo | undefined {
  return sessions.value.find((s) => s.id === id);
}
