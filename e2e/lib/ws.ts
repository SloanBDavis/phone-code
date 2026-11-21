/**
 * A protocol client for tests that talk to the daemon directly (no browser):
 * one websocket, every received frame kept in order.
 */
import type { Daemon } from './daemon.ts';
import { parse, record } from './json.ts';

export type Frame = Record<string, unknown> & { t: string };

export class WsClient {
  readonly frames: Frame[] = [];
  closeCode: number | undefined;
  private readonly ws: WebSocket;
  private waiters: Array<() => void> = [];

  private constructor(daemon: Daemon) {
    this.ws = new WebSocket(`${daemon.url.replace(/^http/, 'ws')}/ws`);
    this.ws.addEventListener('message', (e) => {
      const f = record(parse(String(e.data)));
      this.frames.push({ ...f, t: String(f['t']) });
      this.wake();
    });
    this.ws.addEventListener('close', (e) => {
      this.closeCode = e.code;
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Opens a socket; resolves once it is open, or with the close code if it is refused. */
  static async open(daemon: Daemon): Promise<WsClient> {
    const c = new WsClient(daemon);
    await new Promise<void>((resolve) => {
      c.ws.addEventListener('open', () => resolve());
      c.ws.addEventListener('error', () => resolve());
      c.ws.addEventListener('close', () => resolve());
    });
    return c;
  }

  /** Opens a socket and authenticates with `token`; throws unless the daemon says ready. */
  static async connect(daemon: Daemon, token: string): Promise<WsClient> {
    const c = await WsClient.open(daemon);
    c.send({ t: 'hello', v: 1, token });
    await c.waitFor((f) => f.t === 'ready');
    return c;
  }

  get closed(): boolean {
    return this.closeCode !== undefined;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The first frame (from the start) matching `pred`. */
  async waitFor(pred: (f: Frame) => boolean, ms = 10_000): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit !== undefined) return hit;
      if (this.closed) throw new Error(`socket closed (${this.closeCode}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; frames: ${this.frames.map((f) => f.t).join(',')}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, left);
      });
    }
  }

  /** Resolves with the close code once the daemon closed the socket. */
  async waitClosed(ms = 10_000): Promise<number | undefined> {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) {
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, deadline - Date.now());
      });
    }
    return this.closeCode;
  }

  /** Sends an rpc and waits for its `res`. */
  async rpc(msg: Record<string, unknown> & { id: string }): Promise<Frame> {
    this.send(msg);
    return this.waitFor((f) => f.t === 'res' && f['id'] === msg.id);
  }

  close(): void {
    this.ws.close();
  }
}

/** Does `token` still authenticate? (true: ready; false: refused with 4401) */
export async function tokenWorks(daemon: Daemon, token: string): Promise<boolean> {
  const c = await WsClient.open(daemon);
  c.send({ t: 'hello', v: 1, token });
  try {
    await c.waitFor((f) => f.t === 'ready' || f.t === 'error');
    return c.frames.some((f) => f.t === 'ready');
  } finally {
    c.close();
  }
}
