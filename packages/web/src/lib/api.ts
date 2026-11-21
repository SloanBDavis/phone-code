import type { HandoffResponse, PairRequest, PairResponse } from '@phone-code/protocol';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
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
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.error ?? j.message ?? '';
    } catch {
      // not JSON
    }
    if (!msg)
      msg =
        res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410
          ? 'This pairing code has expired or was already used.'
          : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  return 'Browser';
}

export function pair(code: string): Promise<PairResponse> {
  return post<PairResponse>('/api/pair', { code, deviceName: deviceName() } satisfies PairRequest);
}

export function handoff(token: string): Promise<HandoffResponse> {
  return post<HandoffResponse>('/api/handoff', {}, token);
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
