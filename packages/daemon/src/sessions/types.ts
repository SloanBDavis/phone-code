import type { ChatItem, SessionInfo } from '@phone-code/protocol';

/** A connected client as seen by a session. */
export interface Subscriber {
  readonly connId: number;
  /**
   * Send a pre-serialized frame. Returns false (and sends nothing) when the
   * socket is backed up; the session then drops the subscriber and the client
   * re-subscribes with a fresh snapshot once its socket drains.
   */
  sendFrame(frame: string): boolean;
  /** Tell the client this subscription went stale due to backpressure. */
  markStale(sessionId: string): void;
}

export type ChangeKind = 'structure' | 'activity';

/** What a session needs from the manager. */
export interface SessionHost {
  changed(kind: ChangeKind): void;
  /** The session needs the user (permission / question) or finished a turn. */
  attention(session: SessionInfo, reason: 'waiting' | 'turn'): void;
}

export interface PersistedSession {
  info: SessionInfo;
  seq: number;
  titleLocked: boolean;
  nativeSessionId?: string;
  command?: string;
  cols?: number;
  rows?: number;
}

export interface LiveSession {
  readonly info: SessionInfo;
  subscribe(sub: Subscriber, afterSeq?: number): Promise<void>;
  unsubscribe(sub: Subscriber): void;
  hasSubscribers(): boolean;
  rename(title: string): void;
  toRecord(): PersistedSession;
  /** Flush buffers to disk (daemon shutdown). */
  persist(): Promise<void>;
  /** Kill processes and free resources. */
  dispose(): Promise<void>;
}

export type { ChatItem };
