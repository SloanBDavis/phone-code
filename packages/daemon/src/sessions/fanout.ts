import type { Subscriber } from './types.ts';

/** Live subscribers of one session, with backpressure-aware fan-out. */
export class Fanout {
  private readonly subs = new Set<Subscriber>();

  constructor(private readonly sessionId: string) {}

  get size(): number {
    return this.subs.size;
  }

  add(sub: Subscriber): void {
    this.subs.add(sub);
  }

  delete(sub: Subscriber): void {
    this.subs.delete(sub);
  }

  /** Send to one subscriber; on backpressure, drop it and let it resync later. */
  sendTo(sub: Subscriber, frame: string): boolean {
    if (sub.sendFrame(frame)) return true;
    this.subs.delete(sub);
    sub.markStale(this.sessionId);
    return false;
  }

  publish(frame: string): void {
    for (const sub of this.subs) this.sendTo(sub, frame);
  }

  clear(): void {
    this.subs.clear();
  }
}
