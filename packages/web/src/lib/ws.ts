import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@phone-code/protocol';
import type { Transport, TransportEvents } from './transport';

const PING_EVERY = 15_000;
const DEAD_AFTER = 40_000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15_000;

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * WebSocket transport: authenticates with `hello`, keeps the link alive with
 * pings, and reconnects with jittered exponential backoff. Reconnects early
 * when the page becomes visible again or the network comes back.
 */
export class WsTransport implements Transport {
  readonly demo = false;
  private ws: WebSocket | null = null;
  private events: TransportEvents | null = null;
  private ready = false;
  private attempt = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private lastSeen = 0;
  private stopped = true;
  private everOpened = false;

  constructor(
    private readonly token: string,
    private readonly url = wsUrl(),
  ) {}

  start(events: TransportEvents): void {
    this.events = events;
    this.stopped = false;
    addEventListener('online', this.onOnline);
    addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    removeEventListener('online', this.onOnline);
    removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || !this.ready || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  retryNow(): void {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN && this.ready) return;
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.events?.status('offline');
      return;
    }
    this.ws?.close();
    this.ready = false;
    this.events?.status(this.everOpened ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: this.token } satisfies ClientMessage));
      this.lastSeen = Date.now();
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      if (ws !== this.ws) return;
      this.lastSeen = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'pong') return;
      if (msg.t === 'ready') {
        this.ready = true;
        this.everOpened = true;
        this.attempt = 0;
        this.startPing();
        this.events?.status('open');
      }
      if (msg.t === 'error' && msg.code === 'unauthorized') {
        this.stopped = true;
        this.events?.status('unauthorized', msg.message);
      }
      this.events?.message(msg);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ready = false;
      clearInterval(this.pingTimer);
      if (!this.stopped) this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_AFTER) {
        this.ws?.close();
        return;
      }
      this.send({ t: 'ping' });
    }, PING_EVERY);
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    this.events?.status(navigator.onLine ? (this.everOpened ? 'reconnecting' : 'connecting') : 'offline');
    const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.attempt);
    this.attempt++;
    const delay = base / 2 + Math.random() * (base / 2);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private readonly onOnline = (): void => this.retryNow();
  private readonly onOffline = (): void => this.events?.status('offline');
  private readonly onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    // iOS freezes sockets in the background; check liveness immediately.
    if (this.ready && Date.now() - this.lastSeen > PING_EVERY) {
      const probe = Date.now();
      this.send({ t: 'ping' });
      window.setTimeout(() => {
        if (this.lastSeen < probe) this.ws?.close();
      }, 4000);
    }
    if (!this.ready) this.retryNow();
  };
}
