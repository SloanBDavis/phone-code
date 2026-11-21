import { timingSafeEqual } from 'node:crypto';
import { JsonWriter, randomId, readJson } from '../util/files.ts';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface DeviceRecord {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** sha256(token), base64url. The token itself is never stored. */
  tokenHash: string;
  push: PushSubscriptionRecord[];
}

export type PublicDevice = Pick<DeviceRecord, 'id' | 'name' | 'createdAt' | 'lastSeenAt'> & { push: number };

function hashToken(token: string): Buffer {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(token).digest());
}

function isDeviceRecord(v: unknown): v is DeviceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<DeviceRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.tokenHash === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.lastSeenAt === 'number'
  );
}

/** Paired devices, persisted in devices.json (0600). */
export class DeviceStore {
  private devices = new Map<string, DeviceRecord>();
  private hashes = new Map<string, Buffer>();
  private readonly writer: JsonWriter;

  private constructor(path: string) {
    this.writer = new JsonWriter(path, () => ({ v: 1, devices: [...this.devices.values()] }), 500);
  }

  static async load(path: string): Promise<DeviceStore> {
    const store = new DeviceStore(path);
    const data = await readJson(path);
    const list =
      typeof data === 'object' && data !== null && 'devices' in data && Array.isArray(data.devices)
        ? (data.devices as unknown[])
        : [];
    for (const raw of list) {
      if (!isDeviceRecord(raw)) continue;
      const rec: DeviceRecord = { ...raw, push: Array.isArray(raw.push) ? raw.push : [] };
      store.devices.set(rec.id, rec);
      store.hashes.set(rec.id, Buffer.from(rec.tokenHash, 'base64url'));
    }
    return store;
  }

  /** Create a device and return its (only ever shown once) token. */
  add(name: string): { device: DeviceRecord; token: string } {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const hash = hashToken(token);
    const now = Date.now();
    const device: DeviceRecord = {
      id: randomId(8),
      name,
      createdAt: now,
      lastSeenAt: now,
      tokenHash: hash.toString('base64url'),
      push: [],
    };
    this.devices.set(device.id, device);
    this.hashes.set(device.id, hash);
    this.writer.schedule();
    return { device, token };
  }

  /** Constant-time token check against every device. */
  authenticate(token: string): DeviceRecord | undefined {
    if (token.length < 20 || token.length > 200) return undefined;
    const presented = hashToken(token);
    let found: string | undefined;
    for (const [id, hash] of this.hashes) {
      if (timingSafeEqual(hash, presented)) found = id;
    }
    if (found === undefined) return undefined;
    const device = this.devices.get(found);
    if (device !== undefined) this.touch(device);
    return device;
  }

  touch(device: DeviceRecord): void {
    device.lastSeenAt = Date.now();
    this.writer.schedule();
  }

  get(id: string): DeviceRecord | undefined {
    return this.devices.get(id);
  }

  list(): PublicDevice[] {
    return [...this.devices.values()]
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        push: d.push.length,
      }))
      .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  all(): DeviceRecord[] {
    return [...this.devices.values()];
  }

  /** Accepts an exact id or a unique id prefix. */
  revoke(idOrPrefix: string): DeviceRecord | undefined {
    const exact = this.devices.get(idOrPrefix);
    const matches = exact === undefined ? this.all().filter((d) => d.id.startsWith(idOrPrefix)) : [exact];
    const [target] = matches;
    if (matches.length !== 1 || target === undefined || idOrPrefix === '') return undefined;
    this.devices.delete(target.id);
    this.hashes.delete(target.id);
    this.writer.schedule();
    return target;
  }

  addPush(device: DeviceRecord, sub: PushSubscriptionRecord): void {
    device.push = [...device.push.filter((s) => s.endpoint !== sub.endpoint), sub].slice(-10);
    this.writer.schedule();
  }

  removePush(endpoint: string): void {
    let changed = false;
    for (const d of this.devices.values()) {
      const next = d.push.filter((s) => s.endpoint !== endpoint);
      if (next.length !== d.push.length) {
        d.push = next;
        changed = true;
      }
    }
    if (changed) this.writer.schedule();
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
