/** Messages between the main thread and the screen worker (src/screen-worker.ts). */

export type ScreenRequest =
  | { op: 'open'; id: string; cols: number; rows: number }
  | { op: 'write'; id: string; data: string }
  | { op: 'resize'; id: string; cols: number; rows: number }
  /** Serialize screen + scrollback once everything written before has been parsed. */
  | { op: 'snapshot'; id: string; req: number }
  /** Last non-empty line at or above the cursor. */
  | { op: 'preview'; id: string; req: number }
  | { op: 'close'; id: string };

export type ScreenEvent =
  | { op: 'ack'; id: string; chars: number }
  | { op: 'title'; id: string; title: string }
  | { op: 'reply'; req: number; text: string };

const REQUEST_OPS = new Set(['open', 'write', 'resize', 'snapshot', 'preview', 'close']);
const EVENT_OPS = new Set(['ack', 'title', 'reply']);

function hasOp(v: unknown, ops: Set<string>): boolean {
  return typeof v === 'object' && v !== null && 'op' in v && typeof v.op === 'string' && ops.has(v.op);
}

/** Both ends are our own code; this only guards against a corrupted message. */
export function isScreenRequest(v: unknown): v is ScreenRequest {
  return hasOp(v, REQUEST_OPS);
}

export function isScreenEvent(v: unknown): v is ScreenEvent {
  return hasOp(v, EVENT_OPS);
}
