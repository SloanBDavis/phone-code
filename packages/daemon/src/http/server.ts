import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { HandoffResponse, PairResponse } from '@phone-code/protocol';
import type { DeviceStore, PublicDevice } from '../auth/devices.ts';
import { PAIR_CODE_TTL_MS, type PairingCodes } from '../auth/pairing.ts';
import { DAEMON_VERSION } from '../config.ts';
import type { HostInfoProvider } from '../host-info.ts';
import { log } from '../log.ts';
import {
  arrivedOverHttps,
  isLoopbackHost,
  isLoopbackIp,
  isProxied,
  transportRefusal,
} from '../net/transport.ts';
import { isRecord, parseJson } from '../util/guards.ts';
import { Connection, type ClientContext, type WsData } from '../ws-client.ts';
import { isImageRoute, serveImage } from './images.ts';
import { SECURITY_HEADERS, serveManifest, serveStatic } from './static.ts';
import type { WebAssets } from './web-assets.ts';

const MAX_JSON_BODY = 4096;
const MAX_CURSOR_HOOK_BODY = 8 * 1024 * 1024;
const PORT_ATTEMPTS = 20;
const HSTS = 'max-age=31536000';

export interface ControlApi {
  token: string;
  newPairCode(): { code: string; expiresAt: number; pairUrl: string };
  status(): { url: string; port: number; pid: number };
  /** The device and the devices paired through it (`also`), or undefined if none matches. */
  revoke(id: string): { revoked: PublicDevice; also: PublicDevice[] } | undefined;
  /** One Cursor hook event (cursor/hooks.ts); the answer is printed back to Cursor. */
  cursorHook?(
    event: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface ServerOptions {
  hostname: string;
  port: number;
  assets: WebAssets;
  devices: DeviceStore;
  pairing: PairingCodes;
  host: HostInfoProvider;
  client: ClientContext;
  control: ControlApi;
  /** Allow plain http from the network (--insecure). */
  insecure: boolean;
  /** The advertised URL; its origin may open the websocket. */
  publicUrl: () => string | undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readJsonBody(req: Request, max = MAX_JSON_BODY): Promise<Record<string, unknown> | undefined> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) return undefined;
  const text = await req.text();
  if (text.length > max) return undefined;
  const v = parseJson(text);
  return isRecord(v) ? v : undefined;
}

const extraOrigins = new Set(
  (process.env['PHONECODE_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
);

/**
 * Browsers always send Origin on websocket upgrades. Allow same-origin, the
 * public URL, loopback dev servers and explicitly configured origins. Clients
 * without an Origin (scripts, native apps) are allowed: the token in `hello`
 * is the actual authentication.
 */
function originAllowed(req: Request, publicOrigin: string | undefined): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  if (extraOrigins.has(origin) || origin === publicOrigin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === req.headers.get('host')) return true;
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
}

function hostnameOf(hostHeader: string): string | undefined {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return undefined;
  }
}

const extraHosts = new Set(
  [...extraOrigins].flatMap((o) => {
    try {
      return [new URL(o).hostname.toLowerCase()];
    } catch {
      return [];
    }
  }),
);

/**
 * DNS rebinding: a web page can point its own name at 127.0.0.1 and then talk
 * to the daemon as same-origin, reading the answers. Its requests carry that
 * name in Host. /api, /ws and /_control therefore only answer a Host that is
 * loopback, an IP literal (nothing to rebind), the advertised URL's host, or a
 * host of PHONECODE_ALLOWED_ORIGINS.
 */
export function hostAllowed(hostHeader: string | null, publicHost: string | undefined): boolean {
  if (hostHeader === null) return false;
  const h = hostnameOf(hostHeader);
  if (h === undefined || h === '') return false;
  if (isLoopbackHost(h) || h.endsWith('.localhost') || isIP(h) !== 0) return true;
  return h === publicHost || extraHosts.has(h);
}

/**
 * Rate-limit key for typed pairing codes. Behind a local proxy (cloudflared,
 * tailscale serve, nginx) every request comes from loopback, so the key is the
 * client address the proxy reports: CF-Connecting-IP, else the last
 * X-Forwarded-For entry (the one the proxy appended), else the Tailscale login.
 * Those headers are believed only from a loopback peer. A client that forges
 * them only picks its own key; the global limit bounds guessing regardless.
 */
export function clientKey(req: Request, ip: string): string {
  if (!isLoopbackIp(ip) || !isProxied(req)) return ip;
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf !== undefined && cf !== '') return `cf:${cf}`;
  const xff = req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (xff !== undefined && xff !== '') return `xff:${xff}`;
  const ts = req.headers.get('tailscale-user-login')?.trim();
  if (ts !== undefined && ts !== '') return `ts:${ts}`;
  return 'proxy';
}

function sanitizeName(v: unknown): string {
  const name = typeof v === 'string' ? v.replaceAll(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
  return name === '' ? 'Phone' : name.slice(0, 64);
}

function bearer(req: Request): string | undefined {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') === true ? h.slice(7).trim() : undefined;
}

export function startServer(opts: ServerOptions): Bun.Server<WsData> {
  let connCounter = 0;
  const controlToken = Buffer.from(opts.control.token);

  function controlAllowed(req: Request, ip: string): boolean {
    // cloudflared and tailscale serve also connect from loopback, so loopback
    // alone proves nothing: require the secret from control.json and reject
    // anything carrying proxy headers.
    if (!isLoopbackIp(ip) || isProxied(req)) return false;
    const presented = Buffer.from(req.headers.get('x-phonecode-control') ?? '');
    return presented.length === controlToken.length && timingSafeEqual(presented, controlToken);
  }

  async function pair(req: Request, ip: string): Promise<Response> {
    const body = await readJsonBody(req);
    if (body === undefined || typeof body['code'] !== 'string') return json({ error: 'bad request' }, 400);
    const client = clientKey(req, ip);
    const result = opts.pairing.redeem(body['code'], client);
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        return json(
          { error: 'Too many wrong codes were typed. Wait a minute, or scan the QR code instead.' },
          429,
        );
      }
      log.info(`pairing attempt with an invalid code from ${client}`);
      return json({ error: 'invalid or expired code' }, 401);
    }
    // A handoff code makes the new device a child of the one that minted it.
    const { device, token } = opts.devices.add(sanitizeName(body['deviceName']), result.issuer);
    log.info(`paired new device "${device.name}" (${device.id}) via ${result.kind}`);
    const res: PairResponse = { deviceId: device.id, token, host: opts.host.short };
    return json(res);
  }

  function handoff(req: Request): Response {
    const token = bearer(req);
    const device = token === undefined ? undefined : opts.devices.authenticate(token);
    if (device === undefined) return json({ error: 'unauthorized' }, 401);
    const { code, expiresAt } = opts.pairing.create('handoff', PAIR_CODE_TTL_MS, device.id);
    const res: HandoffResponse = { code, expiresAt };
    return json(res);
  }

  /** The phone unpairs itself: forget its token so it stops working everywhere. */
  async function unpair(req: Request): Promise<Response> {
    const token = bearer(req);
    const device = token === undefined ? undefined : opts.devices.authenticate(token);
    if (device === undefined) return json({ error: 'unauthorized' }, 401);
    opts.control.revoke(device.id);
    await opts.devices.flush();
    return json({ ok: true });
  }

  async function control(req: Request, path: string, server: Bun.Server<WsData>): Promise<Response> {
    const hook = /^\/_control\/cursor\/([A-Za-z]{1,40})$/.exec(path)?.[1];
    if (hook !== undefined && req.method === 'POST' && opts.control.cursorHook !== undefined) {
      // A finished turn may wait for a reply from the phone: no idle timeout for it.
      if (hook === 'stop') server.timeout(req, 0);
      // Hook events carry whole tool outputs and responses (control requests only: token-checked).
      const body = await readJsonBody(req, MAX_CURSOR_HOOK_BODY);
      return json(await opts.control.cursorHook(hook, body ?? {}, req.signal));
    }
    if (path === '/_control/status' && req.method === 'GET') return json(opts.control.status());
    if (path === '/_control/pair' && req.method === 'POST') return json(opts.control.newPairCode());
    if (path === '/_control/devices' && req.method === 'GET') return json({ devices: opts.devices.list() });
    if (path === '/_control/revoke' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = body?.['id'];
      if (typeof id !== 'string') return json({ error: 'bad request' }, 400);
      const result = opts.control.revoke(id);
      // Answer only once devices.json no longer has it: a crash must not bring it back.
      if (result !== undefined) await opts.devices.flush();
      return json({ revoked: result?.revoked ?? null, also: result?.also ?? [] });
    }
    return json({ error: 'not found' }, 404);
  }

  function publicOrigin(): string | undefined {
    const u = opts.publicUrl();
    return u === undefined ? undefined : new URL(u).origin;
  }

  function publicHost(): string | undefined {
    const u = opts.publicUrl();
    return u === undefined ? undefined : new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  }

  const route = async (
    req: Request,
    server: Bun.Server<WsData>,
    url: URL,
    ip: string,
  ): Promise<Response | undefined> => {
    const path = url.pathname;
    const sensitive = path === '/ws' || path.startsWith('/api/') || path.startsWith('/_control/');
    if (sensitive && !hostAllowed(req.headers.get('host'), publicHost())) {
      log.info(`refused ${path} for host ${req.headers.get('host') ?? ''} (not this daemon's address)`);
      return json(
        {
          error:
            'Unknown host. Open the URL phonecode printed, or list this origin in PHONECODE_ALLOWED_ORIGINS.',
        },
        421,
      );
    }
    if (!opts.insecure && (path === '/ws' || path.startsWith('/api/'))) {
      const refusal = transportRefusal(req, ip);
      if (refusal !== undefined) {
        log.info(`refused ${path} from ${ip}: not encrypted`);
        return json({ error: refusal }, 403);
      }
    }
    if (path === '/ws') {
      if (!originAllowed(req, publicOrigin())) {
        log.info(`rejected websocket from origin ${req.headers.get('origin') ?? ''}`);
        return new Response('Forbidden origin', { status: 403 });
      }
      connCounter += 1;
      if (server.upgrade(req, { data: { connId: connCounter, ip } })) return undefined;
      return new Response('Expected a websocket', { status: 426 });
    }
    if (path.startsWith('/_control/')) {
      if (!controlAllowed(req, ip)) return json({ error: 'forbidden' }, 403);
      return control(req, path, server);
    }
    if (path.startsWith('/api/')) {
      // CSRF: a foreign page can POST a simple request here (and burn the
      // pairing rate limit or a leaked code) even though it cannot read the answer.
      if (req.method === 'POST' && !originAllowed(req, publicOrigin())) {
        log.info(`refused ${path} from origin ${req.headers.get('origin') ?? ''}`);
        return json({ error: 'forbidden origin' }, 403);
      }
      if (path === '/api/pair' && req.method === 'POST') return pair(req, ip);
      if (path === '/api/handoff' && req.method === 'POST') return handoff(req);
      if (path === '/api/unpair' && req.method === 'POST') return unpair(req);
      if (path === '/api/health' && req.method === 'GET') return json({ ok: true, version: DAEMON_VERSION });
      if (isImageRoute(path))
        return serveImage(req, url, { devices: opts.devices, manager: opts.client.manager });
      return json({ error: 'not found' }, 404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405 });
    if (path === '/manifest.webmanifest') return serveManifest(url, opts.assets);
    return serveStatic(req, path, opts.assets);
  };

  const fetch = async (req: Request, server: Bun.Server<WsData>): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address ?? 'unknown';
    const res = await route(req, server, url, ip);
    // Pin browsers to https once they reached us through an https proxy.
    if (res !== undefined && arrivedOverHttps(req, ip, opts.publicUrl())) {
      res.headers.set('Strict-Transport-Security', HSTS);
    }
    return res;
  };

  const options: Bun.Serve.Options<WsData> = {
    hostname: opts.hostname,
    port: opts.port,
    fetch,
    error(err) {
      log.error('http handler failed', err);
      return new Response('Internal error', { status: 500 });
    },
    websocket: {
      maxPayloadLength: 32 * 1024 * 1024,
      backpressureLimit: 32 * 1024 * 1024,
      closeOnBackpressureLimit: false,
      idleTimeout: 60,
      sendPings: true,
      open(ws) {
        ws.data.conn = new Connection(ws, opts.client);
      },
      message(ws, message) {
        ws.data.conn?.onMessage(message);
      },
      drain(ws) {
        ws.data.conn?.onDrain();
      },
      close(ws) {
        ws.data.conn?.onClose();
      },
      error(err) {
        log.warn('websocket handler failed', err);
      },
    },
  };

  let lastError: unknown;
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    try {
      return Bun.serve<WsData>({ ...options, port: opts.port + i });
    } catch (err) {
      lastError = err;
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
      if (code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no free port');
}
