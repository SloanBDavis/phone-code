/**
 * Bounded log of serialized frames, keyed by seq, used to replay what a
 * reconnecting client missed (`sub` with `afterSeq`).
 */
export class EventLog {
  private frames: string[] = [];
  private seqs: number[] = [];
  private head = 0;
  private bytes = 0;

  constructor(
    /** seq of the last event before the log began. */
    private baseSeq: number,
    private readonly maxEvents = 4000,
    private readonly maxBytes = 4_000_000,
  ) {}

  push(seq: number, frame: string): void {
    this.frames.push(frame);
    this.seqs.push(seq);
    this.bytes += frame.length;
    while (
      this.frames.length - this.head > this.maxEvents ||
      (this.bytes > this.maxBytes && this.size() > 1)
    ) {
      this.bytes -= this.frames[this.head]?.length ?? 0;
      this.baseSeq = this.seqs[this.head] ?? this.baseSeq;
      this.head += 1;
    }
    // Compact the backing arrays occasionally instead of shifting each time.
    if (this.head > 1024 && this.head * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.head);
      this.seqs = this.seqs.slice(this.head);
      this.head = 0;
    }
  }

  private size(): number {
    return this.frames.length - this.head;
  }

  /** Frames after `afterSeq`, or undefined when that point fell out of the log. */
  since(afterSeq: number, currentSeq: number): string[] | undefined {
    if (afterSeq > currentSeq || afterSeq < this.baseSeq) return undefined;
    const out: string[] = [];
    for (let i = this.head; i < this.frames.length; i++) {
      const seq = this.seqs[i];
      const frame = this.frames[i];
      if (seq !== undefined && frame !== undefined && seq > afterSeq) out.push(frame);
    }
    return out;
  }
}
