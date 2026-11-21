import { batch } from '@preact/signals';
import type { Attachment, ClientMessage, RpcResults, ServerMessage } from '@phone-code/protocol';
import {
  appendDelta,
  chatOf,
  conn,
  deviceId,
  host,
  isDemo,
  resetChat,
  sessions,
  sessionsLoaded,
  upsertItem,
  vapidKey,
} from './state';
import type { Transport } from './transport';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RpcRequest = DistOmit<Extract<ClientMessage, { id: string }>, 'id'>;

export interface TermListener {
  snapshot(data: string, cols: number, rows: number): void;
  data(data: string): void;
  exit(code: number | null): void;
}

interface PendingRpc {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: number;
}

const RPC_TIMEOUT = 20_000;

let counter = 0;
export const uid = (prefix = 'c'): string =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Everything above the transport: rpc bookkeeping, ref-counted
 * subscriptions with resume-from-seq, an outbox while disconnected, and
 * per-frame batching of chat updates into the signal store.
 */
class Client {
  private transport: Transport | null = null;
  private readonly rpcs = new Map<string, PendingRpc>();
  private outbox: ClientMessage[] = [];
  private readonly subs = new Map<string, number>();
  private readonly seqs = new Map<string, number>();
  private readonly term = new Map<string, Set<TermListener>>();
  private inbox: ServerMessage[] = [];
  private flushScheduled = false;

  start(transport: Transport): void {
    this.stop();
    this.transport = transport;
    isDemo.value = transport.demo;
    transport.start({
      message: (m) => this.onMessage(m),
      status: (status, detail) => {
        conn.value = { status, detail };
      },
    });
  }

  stop(): void {
    this.transport?.stop();
    this.transport = null;
    for (const p of this.rpcs.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Disconnected'));
    }
    this.rpcs.clear();
    this.outbox = [];
    this.subs.clear();
    this.seqs.clear();
    batch(() => {
      conn.value = { status: 'idle' };
      sessions.value = [];
      sessionsLoaded.value = false;
      host.value = null;
    });
  }

  retryNow(): void {
    this.transport?.retryNow();
  }

  send(msg: ClientMessage): void {
    if (this.transport?.send(msg)) return;
    if (msg.t === 'ping' || msg.t === 'hello') return;
    this.outbox.push(msg);
  }

  rpc<R extends RpcRequest>(req: R): Promise<RpcResults[R['t']]> {
    const id = uid('r');
    return new Promise<RpcResults[R['t']]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.rpcs.delete(id);
        this.outbox = this.outbox.filter((m) => !('id' in m) || m.id !== id);
        reject(new Error('The host did not answer in time'));
      }, RPC_TIMEOUT);
      this.rpcs.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ ...req, id } as ClientMessage);
    });
  }

  /** Ref-counted; returns the unsubscribe function. */
  subscribe(sessionId: string): () => void {
    const n = this.subs.get(sessionId) ?? 0;
    this.subs.set(sessionId, n + 1);
    if (n === 0) this.sendSub(sessionId);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.subs.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        this.subs.set(sessionId, left);
        return;
      }
      this.subs.delete(sessionId);
      // Terminals need a fresh snapshot when remounted; chats keep their state.
      if (this.term.has(sessionId)) this.seqs.delete(sessionId);
      this.send({ t: 'unsub', sessionId });
    };
  }

  onTerm(sessionId: string, l: TermListener): () => void {
    let set = this.term.get(sessionId);
    if (!set) {
      set = new Set();
      this.term.set(sessionId, set);
    }
    set.add(l);
    return () => {
      set.delete(l);
      if (set.size === 0) this.term.delete(sessionId);
    };
  }

  /** Optimistic send: the bubble appears immediately and settles on ack. */
  async sendChat(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const c = chatOf(sessionId);
    const localId = uid('local');
    const images = attachments.map((a) => `data:${a.mediaType};base64,${a.data}`);
    c.pending.value = [
      ...c.pending.value,
      { localId, text, images, ts: Date.now(), status: 'sending' as const },
    ];
    try {
      const res = await this.rpc({
        t: 'chat.send',
        sessionId,
        text,
        ...(attachments.length ? { attachments } : {}),
      });
      if (c.items.has(res.itemId)) c.pending.value = c.pending.value.filter((p) => p.localId !== localId);
      else
        c.pending.value = c.pending.value.map((p) =>
          p.localId === localId ? { ...p, awaitId: res.itemId } : p,
        );
    } catch {
      c.pending.value = c.pending.value.map((p) =>
        p.localId === localId ? { ...p, status: 'failed' as const } : p,
      );
    }
  }

  retrySend(sessionId: string, localId: string): void {
    const c = chatOf(sessionId);
    const p = c.pending.value.find((x) => x.localId === localId);
    if (!p) return;
    c.pending.value = c.pending.value.filter((x) => x.localId !== localId);
    const attachments: Attachment[] = p.images.map((url) => {
      const [head = '', data = ''] = url.split(',');
      return { mediaType: head.slice(5, head.indexOf(';')), data };
    });
    void this.sendChat(sessionId, p.text, attachments);
  }

  private sendSub(sessionId: string): void {
    const afterSeq = this.seqs.get(sessionId);
    this.send(afterSeq === undefined ? { t: 'sub', sessionId } : { t: 'sub', sessionId, afterSeq });
  }

  private onMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'ready': {
        batch(() => {
          host.value = m.host;
          deviceId.value = m.deviceId;
          vapidKey.value = m.vapidPublicKey;
        });
        const out = this.outbox;
        this.outbox = [];
        // Subscriptions first so queued sends land in a subscribed session.
        for (const id of this.subs.keys()) this.sendSub(id);
        for (const msg of out) if (msg.t !== 'sub' && msg.t !== 'unsub') this.send(msg);
        return;
      }
      case 'res': {
        const p = this.rpcs.get(m.id);
        if (!p) return;
        this.rpcs.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error));
        return;
      }
      case 'term.snapshot':
        this.seqs.set(m.sessionId, m.seq);
        for (const l of this.term.get(m.sessionId) ?? []) l.snapshot(m.data, m.cols, m.rows);
        return;
      case 'term.data':
        if (!this.fresh(m.sessionId, m.seq)) return;
        for (const l of this.term.get(m.sessionId) ?? []) l.data(m.data);
        return;
      case 'term.exit':
        for (const l of this.term.get(m.sessionId) ?? []) l.exit(m.exitCode);
        return;
      case 'error':
      case 'pong':
        return;
      case 'sessions':
      case 'chat.snapshot':
      case 'chat.item':
      case 'chat.delta':
        this.inbox.push(m);
        this.scheduleFlush();
        return;
      default: {
        const never: never = m;
        return never;
      }
    }
  }

  private fresh(sessionId: string, seq: number): boolean {
    const last = this.seqs.get(sessionId);
    if (last !== undefined && seq <= last) return false;
    this.seqs.set(sessionId, seq);
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = (): void => this.flush();
    if (document.visibilityState === 'visible') requestAnimationFrame(run);
    else setTimeout(run, 50);
  }

  private flush(): void {
    this.flushScheduled = false;
    const msgs = this.inbox;
    this.inbox = [];
    batch(() => {
      for (const m of msgs) {
        switch (m.t) {
          case 'sessions':
            sessions.value = m.sessions;
            sessionsLoaded.value = true;
            break;
          case 'chat.snapshot':
            this.seqs.set(m.sessionId, m.seq);
            resetChat(m.sessionId, m.items);
            break;
          case 'chat.item':
            if (this.fresh(m.sessionId, m.seq)) upsertItem(m.sessionId, m.item);
            break;
          case 'chat.delta':
            if (this.fresh(m.sessionId, m.seq)) appendDelta(m.sessionId, m.itemId, m.text);
            break;
          default:
            break;
        }
      }
    });
  }
}

export const client = new Client();
