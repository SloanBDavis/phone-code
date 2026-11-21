import type { ClientMessage, ServerMessage } from '@phone-code/protocol';

/**
 * connecting    first attempt, nothing received yet
 * open          `ready` received, fully usable
 * reconnecting  lost the connection, retrying with backoff
 * offline       the browser reports no network
 * unauthorized  the daemon rejected our token (needs re-pairing)
 */
export type TransportStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'unauthorized';

export interface TransportEvents {
  message(msg: ServerMessage): void;
  status(status: TransportStatus, detail?: string): void;
}

/**
 * A duplex channel to a host. The real implementation speaks WebSocket to the
 * daemon; the demo implementation simulates a host in the browser. Both
 * deliver the same `ServerMessage`s, so everything above this is shared.
 */
export interface Transport {
  readonly demo: boolean;
  start(events: TransportEvents): void;
  stop(): void;
  /** Returns false when the message could not be sent (not open). */
  send(msg: ClientMessage): boolean;
  /** Skip the backoff wait and try to connect right now. */
  retryNow(): void;
  /** Bytes queued but not yet sent (for upload progress); 0 when unknown. */
  buffered(): number;
  /** The bytes of an image stored for a session (`?w=` for a thumbnail). */
  image(sessionId: string, imageId: string, width?: number): Promise<Blob>;
}
