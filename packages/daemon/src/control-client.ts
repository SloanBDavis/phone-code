/** CLI side of the local control endpoint (`phonecode pair|devices|revoke`). */
import type { PublicDevice } from './auth/devices.ts';
import { statePaths } from './config.ts';
import type { ControlFile, PairCode } from './daemon.ts';
import { readJson } from './util/files.ts';
import { isRecord } from './util/guards.ts';

function isPublicDevice(v: unknown): v is PublicDevice {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['createdAt'] === 'number' &&
    typeof v['lastSeenAt'] === 'number' &&
    typeof v['push'] === 'number'
  );
}

async function controlFile(home: string): Promise<ControlFile | undefined> {
  const v = await readJson(statePaths(home).control);
  if (typeof v !== 'object' || v === null) return undefined;
  const c = v as Partial<ControlFile>;
  return typeof c.port === 'number' && typeof c.token === 'string' && typeof c.pid === 'number'
    ? { port: c.port, token: c.token, pid: c.pid }
    : undefined;
}

/** Pid of a daemon that holds this state dir and is still alive (it may not answer yet). */
export async function liveDaemonPid(home: string): Promise<number | undefined> {
  const file = await controlFile(home);
  if (file === undefined || file.pid === process.pid) return undefined;
  try {
    process.kill(file.pid, 0);
    return file.pid;
  } catch (err) {
    return isRecord(err) && err['code'] === 'EPERM' ? file.pid : undefined;
  }
}

export class ControlClient {
  private constructor(private readonly file: ControlFile) {}

  /** Connect to the running daemon, or undefined if none is running. */
  static async connect(home: string): Promise<ControlClient | undefined> {
    const file = await controlFile(home);
    if (file === undefined) return undefined;
    const client = new ControlClient(file);
    try {
      await client.call('GET', '/_control/status');
      return client;
    } catch {
      return undefined;
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.file.port}${path}`, {
      method,
      headers: { 'x-phonecode-control': this.file.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`daemon answered ${res.status}`);
    return res.json();
  }

  async pair(): Promise<PairCode> {
    const r = await this.call('POST', '/_control/pair');
    if (!isRecord(r) || typeof r['code'] !== 'string' || typeof r['pairUrl'] !== 'string') {
      throw new Error('unexpected answer from the daemon');
    }
    return { code: r['code'], pairUrl: r['pairUrl'], expiresAt: Number(r['expiresAt']) };
  }

  async devices(): Promise<PublicDevice[]> {
    const r = await this.call('GET', '/_control/devices');
    const list: unknown = isRecord(r) ? r['devices'] : undefined;
    return Array.isArray(list) ? list.filter(isPublicDevice) : [];
  }

  async revoke(id: string): Promise<PublicDevice | null> {
    const r = await this.call('POST', '/_control/revoke', { id });
    const revoked: unknown = isRecord(r) ? r['revoked'] : undefined;
    return isPublicDevice(revoked) ? revoked : null;
  }
}
