/**
 * Who can spend or block a pairing code, from the test process (no browser):
 * web pages in the user's browser (CSRF, DNS rebinding) and clients that keep
 * guessing through a tunnel or proxy, where every request arrives from
 * loopback. Tests run in order: the last ones exhaust the rate limit.
 */
import { request } from 'node:http';
import { expect, test } from '../lib/fixtures.ts';
import type { Daemon } from '../lib/daemon.ts';

/** A raw request, so the test controls Host and Origin like a browser page would. */
function raw(
  daemon: Daemon,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: daemon.port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** What cloudflared / tailscale serve / nginx add for a client at `addr`. */
const viaProxy = (addr: string): Record<string, string> => ({
  'x-forwarded-for': addr,
  'x-forwarded-proto': 'https',
});

const linkCode = (pairUrl: string): string =>
  new URLSearchParams(new URL(pairUrl).hash.split('?')[1] ?? '').get('c') ?? '';

test('a foreign web page cannot post to /api/pair (CSRF)', async ({ daemon }) => {
  const { code } = await daemon.newPairCode();
  const body = JSON.stringify({ code, deviceName: 'evil' });
  // A no-cors form post: text/plain, Origin of the page.
  const status = await raw(
    daemon,
    'POST',
    '/api/pair',
    { origin: 'https://evil.example', 'content-type': 'text/plain', host: `127.0.0.1:${daemon.port}` },
    body,
  );
  expect(status).toBe(403);
  // The code was not spent.
  expect((await daemon.pairWith(code)).status).toBe(200);
});

test('a DNS-rebound name is refused on /api, /ws and /_control', async ({ daemon }) => {
  const evil = {
    host: `rebind.evil.example:${daemon.port}`,
    origin: `http://rebind.evil.example:${daemon.port}`,
  };
  const { code } = await daemon.newPairCode();
  expect(await raw(daemon, 'GET', '/api/health', evil)).toBe(421);
  expect(
    await raw(
      daemon,
      'POST',
      '/api/pair',
      { ...evil, 'content-type': 'application/json' },
      JSON.stringify({ code }),
    ),
  ).toBe(421);
  const upgrade = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  };
  expect(await raw(daemon, 'GET', '/ws', { ...evil, ...upgrade })).toBe(421);
  expect(await raw(daemon, 'POST', '/_control/pair', evil)).toBe(421);
  // The real names still work, and the code was not spent.
  expect(await raw(daemon, 'GET', '/api/health', { host: `localhost:${daemon.port}` })).toBe(200);
  expect(await raw(daemon, 'GET', '/api/health', { host: `127.0.0.1:${daemon.port}` })).toBe(200);
  expect((await daemon.pairWith(code)).status).toBe(200);
});

test('a client that keeps guessing is limited without locking out other clients', async ({ daemon }) => {
  const attacker = viaProxy('203.0.113.7');
  for (let i = 0; i < 8; i++) expect((await daemon.pairWith('WRONGCODE2', attacker)).status).toBe(401);
  expect((await daemon.pairWith('WRONGCODE3', attacker)).status).toBe(429);
  // A forged X-Forwarded-For entry before the proxy's own does not help.
  expect(
    (await daemon.pairWith('WRONGCODE4', { ...attacker, 'x-forwarded-for': '10.9.9.9, 203.0.113.7' })).status,
  ).toBe(429);
  // Somebody else, through the same proxy, types a valid code.
  const { code } = await daemon.newPairCode();
  expect((await daemon.pairWith(code, viaProxy('198.51.100.2'))).status).toBe(200);
});

test('nobody can lock out the holder of a pairing link or a handoff code', async ({ daemon }) => {
  const paired = await daemon.pairDevice();
  // Exhaust the global budget for typed codes from many addresses.
  for (let i = 0; i < 40; i++) {
    const status = (await daemon.pairWith('WRONGCODE2', viaProxy(`192.0.2.${i}`))).status;
    expect([401, 429]).toContain(status);
  }
  const { code, pairUrl } = await daemon.newPairCode();
  expect((await daemon.pairWith(code, viaProxy('198.51.100.9'))).status).toBe(429);
  // The QR link carries the long form of the same code: never rate limited.
  expect((await daemon.pairWith(linkCode(pairUrl), viaProxy('198.51.100.9'))).status).toBe(200);
  // Nor is a handoff code (only the long form exists).
  const handoff = await daemon.handoff(paired.token);
  expect((await daemon.pairWith(handoff, viaProxy('198.51.100.9'))).status).toBe(200);
});
