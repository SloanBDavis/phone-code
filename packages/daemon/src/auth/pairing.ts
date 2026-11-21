import { timingSafeEqual } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** The code a person types: ~49 bits, so guesses must be rate limited. */
const CODE_LENGTH = 10;
/**
 * The secret in the QR / pairing link and in handoff codes: ~128 bits. Nobody
 * types it, and nobody can guess it at any rate, so it is never rate limited:
 * a flood of wrong guesses cannot stop the holder of a valid link.
 */
export const LINK_LENGTH = 26;
export const PAIR_CODE_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_CODES = 16;

/** Failed attempts with a typed code, per client and in total, per minute. */
const FAILS_PER_CLIENT_PER_MIN = 8;
const FAILS_GLOBAL_PER_MIN = 40;
/** Clients tracked at once; beyond it the per-client table is reset (the global limit still holds). */
const MAX_TRACKED_CLIENTS = 1024;

export type CodeKind = 'pair' | 'handoff';

interface ActiveCode {
  /** The typed form; handoff codes have none. */
  code: string | undefined;
  /** The link form (QR, pairing URL, handoff). */
  link: string;
  kind: CodeKind;
  expiresAt: number;
  /** Only the `PHONECODE_PAIR_CODE` test hook creates reusable codes. */
  reusable: boolean;
  /** Handoff codes: the device that minted it (revoking it voids the code). */
  issuer?: string;
}

export type RedeemResult =
  | { ok: true; kind: CodeKind; issuer?: string }
  | { ok: false; reason: 'invalid' | 'rate_limited' };

function randomCode(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 248 && out.length < length) out += ALPHABET.charAt(byte % ALPHABET.length);
    }
  }
  return out;
}

/** Uppercase and drop separators so "k7qm-3xpa 9d" matches "K7QM3XPA9D". */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replaceAll(/[^0-9A-Z]/g, '');
}

function same(a: string | undefined, presented: Buffer): boolean {
  if (a === undefined) return false;
  const candidate = Buffer.from(a);
  return candidate.length === presented.length && timingSafeEqual(candidate, presented);
}

/**
 * Single-use, expiring pairing and handoff codes. Each pairing code has a
 * short typed form (rate limited per client and globally) and a long link
 * form (never rate limited); redeeming either one spends both.
 */
export class PairingCodes {
  private codes: ActiveCode[] = [];
  private failsByClient = new Map<string, number[]>();
  private failsGlobal: number[] = [];

  /** Install a fixed code (test hook). It never expires and can be reused. */
  addFixed(code: string): string {
    const normalized = normalizeCode(code);
    this.codes.push({
      code: normalized,
      link: normalized,
      kind: 'pair',
      expiresAt: Number.POSITIVE_INFINITY,
      reusable: true,
    });
    return normalized;
  }

  /**
   * A fresh code. `code` is what a person types (for a handoff code, which is
   * never typed, the link form), `link` goes into URLs.
   */
  create(
    kind: CodeKind,
    ttlMs = PAIR_CODE_TTL_MS,
    issuer?: string,
  ): { code: string; link: string; expiresAt: number } {
    this.prune();
    while (this.codes.length >= MAX_ACTIVE_CODES) this.codes.shift();
    const entry: ActiveCode = {
      code: kind === 'pair' ? randomCode(CODE_LENGTH) : undefined,
      link: randomCode(LINK_LENGTH),
      kind,
      expiresAt: Date.now() + ttlMs,
      reusable: false,
      ...(issuer === undefined ? {} : { issuer }),
    };
    this.codes.push(entry);
    return { code: entry.code ?? entry.link, link: entry.link, expiresAt: entry.expiresAt };
  }

  /** Revoked devices must not pair a new one through handoff codes they minted earlier. */
  forgetDevices(deviceIds: ReadonlySet<string>): void {
    this.codes = this.codes.filter((c) => c.issuer === undefined || !deviceIds.has(c.issuer));
  }

  /**
   * `client` is the rate-limit key: the trusted client address (see
   * http/server.ts clientKey). Only typed-form attempts count and are limited.
   */
  redeem(rawCode: string, client: string): RedeemResult {
    const now = Date.now();
    const normalized = normalizeCode(rawCode);
    const typed = normalized.length !== LINK_LENGTH;
    if (typed && this.isRateLimited(client, now)) return { ok: false, reason: 'rate_limited' };
    this.prune();
    const presented = Buffer.from(normalized);
    let match: ActiveCode | undefined;
    // Compare against every active code in constant time per code.
    for (const entry of this.codes) {
      if (typed ? same(entry.code, presented) : same(entry.link, presented)) match = entry;
    }
    if (match === undefined) {
      if (typed) this.recordFailure(client, now);
      return { ok: false, reason: 'invalid' };
    }
    if (!match.reusable) this.codes = this.codes.filter((c) => c !== match);
    return { ok: true, kind: match.kind, ...(match.issuer === undefined ? {} : { issuer: match.issuer }) };
  }

  private prune(): void {
    const now = Date.now();
    this.codes = this.codes.filter((c) => c.expiresAt > now);
  }

  private isRateLimited(client: string, now: number): boolean {
    const cutoff = now - 60_000;
    this.failsGlobal = this.failsGlobal.filter((t) => t > cutoff);
    const mine = (this.failsByClient.get(client) ?? []).filter((t) => t > cutoff);
    if (mine.length === 0) this.failsByClient.delete(client);
    else this.failsByClient.set(client, mine);
    return mine.length >= FAILS_PER_CLIENT_PER_MIN || this.failsGlobal.length >= FAILS_GLOBAL_PER_MIN;
  }

  private recordFailure(client: string, now: number): void {
    this.failsGlobal.push(now);
    if (!this.failsByClient.has(client) && this.failsByClient.size >= MAX_TRACKED_CLIENTS) {
      this.failsByClient.clear();
    }
    const mine = this.failsByClient.get(client) ?? [];
    mine.push(now);
    this.failsByClient.set(client, mine);
  }
}
