import type { PushPayload, SessionInfo } from '@phone-code/protocol';
import type * as WebPush from 'web-push';
import type { DeviceStore, PushSubscriptionRecord } from './auth/devices.ts';
import { log } from './log.ts';
import { readJson, writeFileAtomic } from './util/files.ts';

interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url, 32 bytes
}

const SUBJECT = process.env['PHONECODE_VAPID_SUBJECT'] ?? 'mailto:phone-code@users.noreply.github.com';
const MIN_INTERVAL_MS = 5000;

async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (jwk.d === undefined) throw new Error('VAPID key export failed');
  return { publicKey: Buffer.from(raw).toString('base64url'), privateKey: jwk.d };
}

async function loadOrCreateKeys(path: string): Promise<VapidKeys> {
  const existing = await readJson(path);
  if (typeof existing === 'object' && existing !== null) {
    const k = existing as Partial<VapidKeys>;
    if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string') {
      return { publicKey: k.publicKey, privateKey: k.privateKey };
    }
  }
  const keys = await generateVapidKeys();
  await writeFileAtomic(path, JSON.stringify(keys));
  return keys;
}

/** Web Push delivery. Every failure is swallowed: push is best effort. */
export class PushService {
  private lastSent = new Map<string, number>();
  private webPush: Promise<typeof WebPush> | undefined;

  private constructor(
    private readonly keys: VapidKeys,
    private readonly devices: DeviceStore,
  ) {}

  static async create(path: string, devices: DeviceStore): Promise<PushService | undefined> {
    try {
      return new PushService(await loadOrCreateKeys(path), devices);
    } catch (err) {
      log.warn('web push disabled: could not set up VAPID keys', err);
      return undefined;
    }
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  notify(session: SessionInfo, reason: 'waiting' | 'turn'): void {
    const key = `${session.id}:${reason}`;
    const now = Date.now();
    if (now - (this.lastSent.get(key) ?? 0) < MIN_INTERVAL_MS) return;
    this.lastSent.set(key, now);
    const body =
      reason === 'waiting'
        ? (session.preview ?? 'Waiting for your answer')
        : session.preview !== undefined
          ? session.preview
          : 'Finished';
    const payload: PushPayload = {
      title: reason === 'waiting' ? `${session.title} needs you` : `${session.title} is done`,
      body,
      sessionId: session.id,
      // One notification per session: "needs you" and "is done" replace each other.
      tag: session.id,
    };
    void this.sendAll(payload);
  }

  private async sendAll(payload: PushPayload): Promise<void> {
    const subs = this.devices.all().flatMap((d) => d.push);
    if (subs.length === 0) return;
    try {
      this.webPush ??= import('web-push');
      const wp = await this.webPush;
      const body = JSON.stringify(payload);
      await Promise.all(subs.map((s) => this.sendOne(wp, s, body)));
    } catch (err) {
      log.debug('web push unavailable', err);
    }
  }

  private async sendOne(wp: typeof WebPush, sub: PushSubscriptionRecord, body: string): Promise<void> {
    try {
      await wp.sendNotification(sub, body, {
        TTL: 3600,
        urgency: 'high',
        timeout: 10_000,
        vapidDetails: { subject: SUBJECT, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
      });
    } catch (err) {
      const status =
        typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 0;
      if (status === 404 || status === 410) this.devices.removePush(sub.endpoint);
      else log.debug(`push delivery failed (${status})`);
    }
  }
}
