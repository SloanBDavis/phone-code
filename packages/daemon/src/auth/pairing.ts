import { timingSafeEqual } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 10; // ~49 bits
export const PAIR_CODE_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_CODES = 16;

const FAILS_PER_IP_PER_MIN = 8;
const FAILS_GLOBAL_PER_MIN = 40;

export type CodeKind = 'pair' | 'handoff';

interface ActiveCode {
  code: string;
  kind: CodeKind;
  expiresAt: number;
  /** Only the `PHONECODE_PAIR_CODE` test hook creates reusable codes. */
  reusable: boolean;
  /** Handoff codes: the device that minted it (revoking it voids the code). */
  issuer?: string;
}

export type RedeemResult = { ok: true; kind: CodeKind } | { ok: false; reason: 'invalid' | 'rate_limited' };

function randomCode(): string {
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 248 && out.length < CODE_LENGTH) out += ALPHABET.charAt(byte % ALPHABET.length);
    }
  }
  return out;
}

/** Uppercase and drop separators so "k7qm-3xpa 9d" matches "K7QM3XPA9D". */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replaceAll(/[^0-9A-Z]/g, '');
}

/** Single-use, expiring, rate-limited pairing and handoff codes. */
export class PairingCodes {
  private codes: ActiveCode[] = [];
  private failsByIp = new Map<string, number[]>();
  private failsGlobal: number[] = [];

  /** Install a fixed code (test hook). It never expires and can be reused. */
  addFixed(code: string): string {
    const normalized = normalizeCode(code);
    this.codes.push({ code: normalized, kind: 'pair', expiresAt: Number.POSITIVE_INFINITY, reusable: true });
    return normalized;
  }

  create(kind: CodeKind, ttlMs = PAIR_CODE_TTL_MS, issuer?: string): { code: string; expiresAt: number } {
    this.prune();
    while (this.codes.length >= MAX_ACTIVE_CODES) this.codes.shift();
    const entry: ActiveCode = {
      code: randomCode(),
      kind,
      expiresAt: Date.now() + ttlMs,
      reusable: false,
      ...(issuer === undefined ? {} : { issuer }),
    };
    this.codes.push(entry);
    return { code: entry.code, expiresAt: entry.expiresAt };
  }

  /** A revoked device must not pair a new one through a handoff code it minted earlier. */
  forgetDevice(deviceId: string): void {
    this.codes = this.codes.filter((c) => c.issuer !== deviceId);
  }

  redeem(rawCode: string, ip: string): RedeemResult {
    const now = Date.now();
    if (this.isRateLimited(ip, now)) return { ok: false, reason: 'rate_limited' };
    this.prune();
    const presented = Buffer.from(normalizeCode(rawCode));
    let match: ActiveCode | undefined;
    // Compare against every active code in constant time per code.
    for (const entry of this.codes) {
      const candidate = Buffer.from(entry.code);
      if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) match = entry;
    }
    if (match === undefined) {
      this.recordFailure(ip, now);
      return { ok: false, reason: 'invalid' };
    }
    if (!match.reusable) this.codes = this.codes.filter((c) => c !== match);
    return { ok: true, kind: match.kind };
  }

  private prune(): void {
    const now = Date.now();
    this.codes = this.codes.filter((c) => c.expiresAt > now);
  }

  private isRateLimited(ip: string, now: number): boolean {
    const cutoff = now - 60_000;
    this.failsGlobal = this.failsGlobal.filter((t) => t > cutoff);
    const mine = (this.failsByIp.get(ip) ?? []).filter((t) => t > cutoff);
    if (mine.length === 0) this.failsByIp.delete(ip);
    else this.failsByIp.set(ip, mine);
    return mine.length >= FAILS_PER_IP_PER_MIN || this.failsGlobal.length >= FAILS_GLOBAL_PER_MIN;
  }

  private recordFailure(ip: string, now: number): void {
    this.failsGlobal.push(now);
    const mine = this.failsByIp.get(ip) ?? [];
    mine.push(now);
    this.failsByIp.set(ip, mine);
  }
}
