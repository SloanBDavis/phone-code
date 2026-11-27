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
  /** Paired with a handoff code this device minted. Revoking it revokes this one too. */
  parent?: string;
  /**
   * Which app or browser this is, as it names itself (a random id it keeps). Pairing
   * again from the same one replaces its earlier entry instead of adding another.
   */
  clientId?: string;
}

export type PublicDevice = Pick<DeviceRecord, 'id' | 'name' | 'createdAt' | 'lastSeenAt' | 'parent'> & {
  push: number;
};

export function publicDevice(d: DeviceRecord): PublicDevice {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    push: d.push.length,
    ...(d.parent === undefined ? {} : { parent: d.parent }),
  };
}

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
    typeof r.lastSeenAt === 'number' &&
    (r.parent === undefined || typeof r.parent === 'string') &&
    (r.clientId === undefined || typeof r.clientId === 'string')
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
  add(name: string, parent?: string, clientId?: string): { device: DeviceRecord; token: string } {
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
      ...(parent === undefined ? {} : { parent }),
      ...(clientId === undefined ? {} : { clientId }),
    };
    this.devices.set(device.id, device);
    this.hashes.set(device.id, hash);
    this.writer.schedule();
    return { device, token };
  }

  /**
   * The same app or browser paired again: its earlier entries go (their tokens stop
   * working), and what hung off them moves to the new one, namely the devices paired
   * through them and their notification subscriptions. Returns the entries removed.
   */
  supersede(device: DeviceRecord): DeviceRecord[] {
    if (device.clientId === undefined) return [];
    const old = this.all().filter((d) => d.id !== device.id && d.clientId === device.clientId);
    if (old.length === 0) return [];
    const gone = new Set(old.map((d) => d.id));
    for (const d of this.devices.values()) {
      if (d.parent !== undefined && gone.has(d.parent)) d.parent = device.id;
    }
    if (device.parent !== undefined && gone.has(device.parent)) delete device.parent;
    for (const d of old) {
      for (const sub of d.push) this.addPush(device, sub);
      this.devices.delete(d.id);
      this.hashes.delete(d.id);
    }
    this.writer.schedule();
    return old;
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
    return [...this.devices.values()].map(publicDevice).toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  all(): DeviceRecord[] {
    return [...this.devices.values()];
  }

  /**
   * Revoke a device (exact id or unique id prefix) and every device paired
   * through it, transitively: a handoff code minted with a token pairs a
   * device that must not outlive that token. Returns the target first, or an
   * empty list when nothing matches.
   */
  revoke(idOrPrefix: string): DeviceRecord[] {
    const exact = this.devices.get(idOrPrefix);
    const matches = exact === undefined ? this.all().filter((d) => d.id.startsWith(idOrPrefix)) : [exact];
    const [target] = matches;
    if (matches.length !== 1 || target === undefined || idOrPrefix === '') return [];
    const removed = [target];
    const gone = new Set([target.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const d of this.devices.values()) {
        if (d.parent !== undefined && gone.has(d.parent) && !gone.has(d.id)) {
          gone.add(d.id);
          removed.push(d);
          grew = true;
        }
      }
    }
    for (const id of gone) {
      this.devices.delete(id);
      this.hashes.delete(id);
    }
    this.writer.schedule();
    return removed;
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
