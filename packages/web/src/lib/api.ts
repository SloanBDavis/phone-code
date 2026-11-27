import type { HandoffResponse, PairRequest, PairResponse } from '@phone-code/protocol';
import { isRecord, isString, parseJson } from './guards';
import { load, save } from './storage';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(
  path: string,
  body: unknown,
  check: (v: unknown) => v is T,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Could not reach your computer. Is phone-code still running?', 0);
  }
  if (!res.ok) {
    let msg = '';
    const j = parseJson(await res.text().catch(() => ''));
    if (isRecord(j)) msg = isString(j.error) ? j.error : isString(j.message) ? j.message : '';
    if (!msg)
      msg =
        res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410
          ? 'This pairing code has expired or was already used.'
          : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  const data = parseJson(await res.text());
  if (!check(data))
    throw new ApiError('Unexpected answer from your computer. Update phone-code?', res.status);
  return data;
}

function isPairResponse(v: unknown): v is PairResponse {
  return (
    isRecord(v) && isString(v.token) && isString(v.deviceId) && isRecord(v.host) && isString(v.host.name)
  );
}

function isHandoff(v: unknown): v is HandoffResponse {
  return isRecord(v) && isString(v.code) && typeof v.expiresAt === 'number';
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  return 'Browser';
}

/**
 * Which browser (or home-screen app) this is: a random id kept in its storage, so that
 * pairing it again replaces its entry on the computer instead of adding another.
 */
function clientId(): string {
  let id = load<string>('pc.clientId', '', isString);
  if (!/^[\w-]{8,64}$/.test(id)) {
    // Not crypto.randomUUID: that needs https, and a first pairing can be over plain http.
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    save('pc.clientId', id);
  }
  return id;
}

export function pair(code: string): Promise<PairResponse> {
  return post(
    '/api/pair',
    { code, deviceName: deviceName(), clientId: clientId() } satisfies PairRequest,
    isPairResponse,
  );
}

export function handoff(token: string): Promise<HandoffResponse> {
  return post('/api/handoff', {}, isHandoff, token);
}

/** Asks the host to forget this device (revokes its token). */
export async function forgetDevice(token: string): Promise<void> {
  await post('/api/unpair', {}, isRecord, token);
}

/** Accepts a full pairing URL (from the QR or a pasted link) or a bare code. */
export function parsePairing(input: string): { code: string; origin?: string } | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const hashQuery = u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?')) : '';
      const hp = new URLSearchParams(hashQuery);
      const code = hp.get('c') ?? u.searchParams.get('c') ?? u.searchParams.get('h') ?? hp.get('h');
      if (!code) return null;
      return { code, origin: u.origin };
    } catch {
      return null;
    }
  }
  if (/^[\w-]{4,128}$/.test(s)) return { code: s };
  return null;
}
