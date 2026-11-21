import type { ServerWebSocket } from 'bun';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type HostInfo,
  type ServerMessage,
} from '@phone-code/protocol';
import type { DeviceRecord, DeviceStore } from './auth/devices.ts';
import { listDirectory } from './fs-list.ts';
import type { HostInfoProvider } from './host-info.ts';
import { log } from './log.ts';
import type { PushService } from './push.ts';
import { ChatSession } from './sessions/chat.ts';
import type { SessionManager } from './sessions/manager.ts';
import { TerminalSession } from './sessions/terminal.ts';
import type { Subscriber } from './sessions/types.ts';
import { UserError } from './util/errors.ts';
import { parseClientFrame, parsePushSubscription } from './validate.ts';

export const SESSIONS_TOPIC = 'sessions';
const HELLO_TIMEOUT_MS = 5000;
const PREAUTH_MAX_FRAME = 4096;
/** Above this many buffered bytes, session events are skipped and resynced on drain. */
const SOFT_BUFFER_LIMIT = 1_000_000;

export interface WsData {
  connId: number;
  ip: string;
  conn?: Connection;
}

export interface ClientContext {
  devices: DeviceStore;
  manager: SessionManager;
  host: HostInfoProvider;
  push: PushService | undefined;
  registry: ConnectionRegistry;
}

class RpcError extends UserError {}

type RoutedMessage = Exclude<ClientMessage, { t: 'hello' } | { t: 'ping' }>;

/** Live authenticated connections, by device (for revocation). */
export class ConnectionRegistry {
  private readonly conns = new Set<Connection>();

  add(c: Connection): void {
    this.conns.add(c);
  }

  delete(c: Connection): void {
    this.conns.delete(c);
  }

  closeDevice(deviceId: string): void {
    for (const c of this.conns) if (c.deviceId === deviceId) c.close(4401, 'revoked');
  }

  closeAll(): void {
    for (const c of this.conns) c.close(1001, 'daemon shutting down');
  }
}

export class Connection implements Subscriber {
  readonly connId: number;
  private device: DeviceRecord | undefined;
  private readonly subs = new Set<string>();
  private readonly stale = new Set<string>();
  private readying: Promise<void> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly ws: ServerWebSocket<WsData>,
    private readonly ctx: ClientContext,
  ) {
    this.connId = ws.data.connId;
    this.helloTimer = setTimeout(() => {
      if (this.device === undefined) this.fail('unauthorized', 'hello timeout', 4401);
    }, HELLO_TIMEOUT_MS);
  }

  get deviceId(): string | undefined {
    return this.device?.id;
  }

  // ------------------------------------------------------------- sending

  private send(msg: ServerMessage): void {
    if (this.closed) return;
    // 0 means Bun dropped it at the hard backpressure limit: the client is hopeless.
    if (this.ws.send(JSON.stringify(msg)) === 0) this.close(1013, 'backpressure');
  }

  sendFrame(frame: string): boolean {
    if (this.closed || this.ws.getBufferedAmount() > SOFT_BUFFER_LIMIT) return false;
    return this.ws.send(frame) !== 0;
  }

  markStale(sessionId: string): void {
    if (this.subs.has(sessionId)) this.stale.add(sessionId);
  }

  /** The socket drained: resubscribe stale sessions with a fresh snapshot. */
  onDrain(): void {
    for (const id of Array.from(this.stale)) {
      if (this.ws.getBufferedAmount() > SOFT_BUFFER_LIMIT) return;
      this.stale.delete(id);
      const s = this.ctx.manager.get(id);
      if (s !== undefined && this.subs.has(id)) {
        s.subscribe(this).catch((err: unknown) => log.warn('resubscribe failed', err));
      }
    }
  }

  private error(code: ErrorCode, message: string): void {
    this.send({ t: 'error', code, message });
  }

  private fail(code: ErrorCode, message: string, closeCode: number): void {
    this.error(code, message);
    this.close(closeCode, message);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.ws.close(code, reason);
    this.onClose();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    for (const id of this.subs) this.ctx.manager.get(id)?.unsubscribe(this);
    this.subs.clear();
    this.ctx.registry.delete(this);
  }

  // ------------------------------------------------------------ receiving

  onMessage(raw: string | Buffer): void {
    if (typeof raw !== 'string') {
      this.error('bad_request', 'binary frames are not supported');
      return;
    }
    if (this.device === undefined && raw.length > PREAUTH_MAX_FRAME) {
      this.fail('unauthorized', 'hello required', 4401);
      return;
    }
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      if (parsed.id === undefined) this.error('bad_request', parsed.error);
      else this.send({ t: 'res', id: parsed.id, ok: false, error: parsed.error });
      return;
    }
    const msg = parsed.msg;
    if (msg.t === 'ping') {
      this.send({ t: 'pong' });
      return;
    }
    if (msg.t === 'hello') {
      this.hello(msg.v, msg.token);
      return;
    }
    if (this.device === undefined) {
      this.fail('unauthorized', 'hello required', 4401);
      return;
    }
    const readying = this.readying;
    if (readying === undefined) {
      this.dispatch(msg);
    } else {
      void readying.then(() => this.dispatch(msg));
    }
  }

  private hello(v: number, token: string): void {
    if (this.device !== undefined) {
      this.error('bad_request', 'already authenticated');
      return;
    }
    if (v !== PROTOCOL_VERSION) {
      this.fail('version', `protocol version ${PROTOCOL_VERSION} required`, 4400);
      return;
    }
    const device = this.ctx.devices.authenticate(token);
    if (device === undefined) {
      log.info(`rejected websocket from ${this.ws.data.ip}: bad token`);
      this.fail('unauthorized', 'invalid token', 4401);
      return;
    }
    clearTimeout(this.helloTimer);
    this.device = device;
    this.ctx.registry.add(this);
    this.readying = this.ctx.host.full().then((host) => this.sendReady(host, device));
  }

  private sendReady(host: HostInfo, device: DeviceRecord): void {
    this.readying = undefined;
    if (this.closed) return;
    const push = this.ctx.push;
    this.send({
      t: 'ready',
      v: PROTOCOL_VERSION,
      host,
      deviceId: device.id,
      ...(push === undefined ? {} : { vapidPublicKey: push.publicKey }),
    });
    this.send({ t: 'sessions', sessions: this.ctx.manager.list() });
    this.ws.subscribe(SESSIONS_TOPIC);
  }

  private dispatch(msg: RoutedMessage): void {
    if (this.closed) return;
    try {
      this.route(msg);
    } catch (err) {
      log.error(`handler for ${msg.t} threw`, err);
      this.error('internal', 'internal error');
    }
  }

  private rpc(id: string, work: () => unknown): void {
    Promise.resolve()
      .then(work)
      .then(
        (data) =>
          this.send(data === undefined ? { t: 'res', id, ok: true } : { t: 'res', id, ok: true, data }),
        (err: unknown) => {
          const known = err instanceof UserError;
          if (!known) log.error('rpc failed', err);
          this.send({ t: 'res', id, ok: false, error: known ? err.message : 'internal error' });
        },
      );
  }

  private chat(sessionId: string): ChatSession | undefined {
    const s = this.ctx.manager.get(sessionId);
    if (s instanceof ChatSession) return s;
    this.error(s === undefined ? 'not_found' : 'bad_request', `no chat session ${sessionId}`);
    return undefined;
  }

  private terminal(sessionId: string): TerminalSession | undefined {
    const s = this.ctx.manager.get(sessionId);
    if (s instanceof TerminalSession) return s;
    this.error(s === undefined ? 'not_found' : 'bad_request', `no terminal session ${sessionId}`);
    return undefined;
  }

  private route(msg: RoutedMessage): void {
    const { manager, devices } = this.ctx;
    switch (msg.t) {
      case 'session.create':
        this.rpc(msg.id, () => manager.create(msg.params));
        return;
      case 'session.rename':
        this.rpc(msg.id, () => {
          const info = manager.rename(msg.sessionId, msg.title);
          if (info === undefined) throw new RpcError('session not found');
          return info;
        });
        return;
      case 'session.delete':
        this.rpc(msg.id, async () => {
          if (!(await manager.delete(msg.sessionId))) throw new RpcError('session not found');
          this.subs.delete(msg.sessionId);
          return undefined;
        });
        return;
      case 'fs.list':
        this.rpc(msg.id, () => listDirectory(msg.path));
        return;
      case 'history.list':
        this.rpc(msg.id, () => manager.history(msg.agent));
        return;
      case 'sub': {
        const s = manager.get(msg.sessionId);
        if (s === undefined) {
          this.error('not_found', `no session ${msg.sessionId}`);
          return;
        }
        s.unsubscribe(this);
        this.subs.add(msg.sessionId);
        this.stale.delete(msg.sessionId);
        s.subscribe(this, msg.afterSeq).catch((err: unknown) => {
          log.error('subscribe failed', err);
          this.error('internal', 'subscribe failed');
        });
        return;
      }
      case 'unsub':
        manager.get(msg.sessionId)?.unsubscribe(this);
        this.subs.delete(msg.sessionId);
        this.stale.delete(msg.sessionId);
        return;
      case 'chat.send': {
        const s = this.chat(msg.sessionId);
        if (s === undefined) {
          this.send({ t: 'res', id: msg.id, ok: false, error: 'session not found' });
          return;
        }
        this.rpc(msg.id, async () => ({ itemId: await s.send(msg.text, msg.attachments) }));
        return;
      }
      case 'chat.interrupt':
        this.chat(msg.sessionId)?.interrupt();
        return;
      case 'chat.permission':
        this.chat(msg.sessionId)?.resolvePermission(msg.itemId, msg.decision, msg.message);
        return;
      case 'chat.answer':
        this.chat(msg.sessionId)?.answerQuestion(msg.itemId, msg.answers);
        return;
      case 'chat.setMode':
        this.chat(msg.sessionId)?.setMode(msg.permissionMode);
        return;
      case 'chat.setModel':
        this.chat(msg.sessionId)?.setModel(msg.model);
        return;
      case 'term.input':
        this.terminal(msg.sessionId)?.input(msg.data);
        return;
      case 'term.resize':
        this.terminal(msg.sessionId)?.resize(msg.cols, msg.rows);
        return;
      case 'push.subscribe':
        this.rpc(msg.id, () => {
          const sub = parsePushSubscription(msg.subscription);
          if (sub === undefined) throw new RpcError('invalid push subscription');
          if (this.ctx.push === undefined) throw new RpcError('push is not available on this host');
          if (this.device !== undefined) devices.addPush(this.device, sub);
          return undefined;
        });
        return;
      case 'push.unsubscribe':
        this.rpc(msg.id, () => {
          devices.removePush(msg.endpoint);
          return undefined;
        });
        return;
    }
  }
}
