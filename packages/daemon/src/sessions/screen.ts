/**
 * Main-thread side of the screen worker: one shared worker, one handle per
 * terminal session.
 */
import { SCREEN_WORKER_URL } from '../config.ts';
import { log } from '../log.ts';
import { isScreenEvent, type ScreenEvent, type ScreenRequest } from '../screen-protocol.ts';

/**
 * Safety valve for endless floods (`yes`): the PTY cannot be paused, so when
 * the worker falls this far behind we stop feeding it and keep only the most
 * recent output, which is what determines the screen anyway.
 */
const BACKLOG_HIGH = 16_000_000;
const BACKLOG_LOW = 1_000_000;
const DROP_TAIL = 256_000;

export class ScreenHandle {
  private backlog = 0;
  private dropping = false;
  private tail = '';

  constructor(
    private readonly host: ScreenWorker,
    readonly id: string,
    readonly onTitle: (title: string) => void,
  ) {}

  write(data: string): void {
    if (this.dropping) {
      this.tail = (this.tail + data).slice(-DROP_TAIL);
      return;
    }
    if (this.backlog > BACKLOG_HIGH) {
      log.debug(`screen ${this.id} is behind by ${this.backlog} chars; skipping ahead`);
      this.dropping = true;
      this.tail = data.slice(-DROP_TAIL);
      return;
    }
    this.backlog += data.length;
    this.host.post({ op: 'write', id: this.id, data });
  }

  /** @internal */
  acked(chars: number): void {
    this.backlog -= chars;
    if (this.dropping && this.backlog < BACKLOG_LOW) {
      this.dropping = false;
      const tail = this.tail;
      this.tail = '';
      if (tail !== '') this.write(tail);
    }
  }

  resize(cols: number, rows: number): void {
    this.host.post({ op: 'resize', id: this.id, cols, rows });
  }

  /** Serialized screen + scrollback, reflecting everything written so far. */
  snapshot(): Promise<string> {
    return this.host.request((req) => ({ op: 'snapshot', id: this.id, req }));
  }

  preview(): Promise<string> {
    return this.host.request((req) => ({ op: 'preview', id: this.id, req }));
  }

  close(): void {
    this.host.post({ op: 'close', id: this.id });
    this.host.forget(this.id);
  }
}

export class ScreenWorker {
  private static instance: ScreenWorker | undefined;
  private readonly worker: Worker;
  private readonly handles = new Map<string, ScreenHandle>();
  private readonly replies = new Map<number, (text: string) => void>();
  private nextReq = 0;
  private dead = false;

  private constructor() {
    this.worker = new Worker(SCREEN_WORKER_URL);
    this.worker.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (isScreenEvent(e.data)) this.onEvent(e.data);
    });
    this.worker.addEventListener('error', (e) => {
      log.error(`screen worker crashed: ${e.message}; terminal snapshots are unavailable`);
      this.dead = true;
      for (const resolve of this.replies.values()) resolve('');
      this.replies.clear();
    });
  }

  /** The shared worker, started on first use (or early, to warm it). */
  static shared(): ScreenWorker {
    ScreenWorker.instance ??= new ScreenWorker();
    return ScreenWorker.instance;
  }

  open(id: string, cols: number, rows: number, onTitle: (title: string) => void): ScreenHandle {
    const handle = new ScreenHandle(this, id, onTitle);
    this.handles.set(id, handle);
    this.post({ op: 'open', id, cols, rows });
    return handle;
  }

  /** @internal */
  post(msg: ScreenRequest): void {
    // The empty transfer list is explicit: worker messages have no target origin.
    if (!this.dead) this.worker.postMessage(msg, []);
  }

  /** @internal */
  request(build: (req: number) => ScreenRequest): Promise<string> {
    if (this.dead) return Promise.resolve('');
    this.nextReq += 1;
    const req = this.nextReq;
    const { promise, resolve } = Promise.withResolvers<string>();
    this.replies.set(req, resolve);
    this.post(build(req));
    return promise;
  }

  /** @internal */
  forget(id: string): void {
    this.handles.delete(id);
  }

  private onEvent(ev: ScreenEvent): void {
    switch (ev.op) {
      case 'ack':
        this.handles.get(ev.id)?.acked(ev.chars);
        return;
      case 'title':
        this.handles.get(ev.id)?.onTitle(ev.title);
        return;
      case 'reply': {
        const resolve = this.replies.get(ev.req);
        this.replies.delete(ev.req);
        resolve?.(ev.text);
        return;
      }
    }
  }

  terminate(): void {
    this.dead = true;
    this.worker.terminate();
  }
}
