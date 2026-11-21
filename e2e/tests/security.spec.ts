/**
 * Transport-level checks with plain HTTP and WebSocket clients from the test
 * process (no browser): authentication, hostile input, static file serving
 * and the plain-http proxy rule.
 */
import { request } from 'node:http';
import { expect, test } from '../lib/fixtures.ts';
import type { Daemon } from '../lib/daemon.ts';
import { record } from '../lib/json.ts';

interface WsResult {
  messages: Array<Record<string, unknown>>;
  closeCode: number | undefined;
}

/** Opens /ws, sends `frames` in order, collects replies until closed or `untilType` arrives. */
function talk(
  daemon: Daemon,
  frames: Array<string | Uint8Array<ArrayBuffer>>,
  untilType?: string,
): Promise<WsResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${daemon.url.replace('http', 'ws')}/ws`);
    const result: WsResult = { messages: [], closeCode: undefined };
    const timer = setTimeout(() => {
      ws.close();
      resolve(result);
    }, 8000);
    ws.addEventListener('open', () => {
      for (const f of frames) ws.send(f);
    });
    ws.addEventListener('message', (e) => {
      const msg = record(JSON.parse(String(e.data)));
      result.messages.push(msg);
      if (untilType !== undefined && msg['t'] === untilType) {
        clearTimeout(timer);
        ws.close();
        resolve(result);
      }
    });
    ws.addEventListener('close', (e) => {
      clearTimeout(timer);
      result.closeCode = e.code;
      resolve(result);
    });
  });
}

/** GET with a raw, un-normalized request path. */
function rawGet(daemon: Daemon, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: daemon.port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the websocket requires a valid token', async ({ daemon }) => {
  // No hello at all: the first real message is refused.
  const noHello = await talk(daemon, [JSON.stringify({ t: 'sub', sessionId: 'x' })]);
  expect(noHello.messages[0]).toMatchObject({ t: 'error', code: 'unauthorized' });
  expect(noHello.closeCode).toBe(4401);
  expect(noHello.messages.some((m) => m['t'] === 'sessions')).toBe(false);

  const badToken = await talk(daemon, [JSON.stringify({ t: 'hello', v: 1, token: 'x'.repeat(43) })]);
  expect(badToken.messages[0]).toMatchObject({ t: 'error', code: 'unauthorized' });
  expect(badToken.closeCode).toBe(4401);

  const good = await talk(
    daemon,
    [JSON.stringify({ t: 'hello', v: 1, token: await daemon.pairToken() })],
    'sessions',
  );
  expect(good.messages.map((m) => m['t'])).toEqual(['ready', 'sessions']);
});

test('authenticated HTTP endpoints and the control API refuse strangers', async ({ daemon }) => {
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${daemon.url}${path}`, { method: 'POST', headers, body: '{}' });
  expect((await post('/api/handoff')).status).toBe(401);
  expect((await post('/api/handoff', { authorization: 'Bearer nope-nope-nope-nope-nope' })).status).toBe(401);
  expect((await post('/api/unpair')).status).toBe(401);
  expect((await post('/_control/pair')).status).toBe(403);
  expect((await post('/_control/pair', { 'x-phonecode-control': 'guess' })).status).toBe(403);
  expect((await post('/api/pair', { 'content-type': 'application/json' })).status).toBe(400);
});

test('garbage frames do not crash the daemon', async ({ daemon }) => {
  const token = await daemon.pairToken();
  const hello = JSON.stringify({ t: 'hello', v: 1, token });
  const nested = '['.repeat(100_000) + ']'.repeat(100_000);
  const garbage: Array<string | Uint8Array<ArrayBuffer>> = [
    '',
    'not json',
    '{',
    'null',
    '42',
    '[]',
    nested,
    JSON.stringify({ t: 'nope' }),
    JSON.stringify({ t: 'sub' }),
    JSON.stringify({ t: 'sub', sessionId: { $ne: 1 } }),
    JSON.stringify({ t: 'session.create', id: 'r1', params: { kind: 'agent', agent: '../../bin/sh' } }),
    JSON.stringify({
      t: 'session.create',
      id: 'r2',
      params: { kind: 'terminal', cwd: '/definitely/missing' },
    }),
    JSON.stringify({ t: 'fs.list', id: 'r3', path: 12 }),
    JSON.stringify({ t: 'chat.send', id: 'r4', sessionId: 'missing', text: 'hi' }),
    JSON.stringify({ t: 'term.resize', sessionId: 'missing', cols: -1, rows: 1e12 }),
    JSON.stringify({ t: 'push.subscribe', id: 'r5', subscription: { endpoint: 'javascript:alert(1)' } }),
    JSON.stringify({ t: '__proto__', __proto__: { polluted: true } }),
    new Uint8Array([0, 1, 2, 255]),
    'x'.repeat(2_000_000),
    JSON.stringify({ t: 'ping' }),
  ];
  // Before authentication…
  const pre = await talk(daemon, garbage.slice(0, 8));
  expect(pre.closeCode).toBeDefined();
  // …and after.
  const post = await talk(daemon, [hello, ...garbage], 'pong');
  expect(post.messages.some((m) => m['t'] === 'pong')).toBe(true);
  const failed = post.messages.filter((m) => m['t'] === 'res' && m['ok'] === false).map((m) => m['id']);
  expect(failed).toEqual(expect.arrayContaining(['r1', 'r2', 'r3', 'r4', 'r5']));
  expect(daemon.alive).toBe(true);
  // Still serving normally.
  const again = await talk(daemon, [hello, JSON.stringify({ t: 'ping' })], 'pong');
  expect(again.messages.map((m) => m['t'])).toContain('pong');
  expect((await fetch(`${daemon.url}/api/health`)).status).toBe(200);
});

test('static files cannot escape the web root', async ({ daemon }) => {
  const paths = [
    '/../../../../../../etc/passwd',
    '/..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/assets/..%2f..%2f..%2fpackage.json',
    '//etc/passwd',
    '/%00/etc/passwd',
    '/..\\..\\..\\etc\\passwd',
    '/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd',
    '/%',
  ];
  for (const p of paths) {
    const res = await rawGet(daemon, p);
    expect(res.body, p).not.toContain('root:');
    expect(res.body, p).not.toContain('"workspaces"');
    expect(res.body, p).not.toContain('"devDependencies"');
    expect([200, 400, 404], p).toContain(res.status);
    if (res.status === 200) expect(res.body, p).toContain('<!doctype html>');
  }
  // The daemon's own state is never served.
  for (const p of ['/devices.json', '/control.json', '/../state/devices.json']) {
    const res = await rawGet(daemon, p);
    expect(res.body).not.toContain('tokenHash');
    expect(res.body).not.toContain('token');
  }
});

test('/api and /ws refuse requests that came through a proxy over plain http', async ({ daemon }) => {
  const plain = { 'X-Forwarded-Proto': 'http' };
  expect((await rawGet(daemon, '/api/health', plain)).status).toBe(403);
  const pair = await fetch(`${daemon.url}/api/pair`, {
    method: 'POST',
    headers: { ...plain, 'content-type': 'application/json' },
    body: JSON.stringify({ code: daemon.pairCode, deviceName: 'mitm' }),
  });
  expect(pair.status).toBe(403);
  const ws = await rawGet(daemon, '/ws', {
    ...plain,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  });
  expect(ws.status).toBe(403);
  // https through the proxy is fine.
  expect((await rawGet(daemon, '/api/health', { 'X-Forwarded-Proto': 'https' })).status).toBe(200);
  // And the startup code was not spent by the refused attempt.
  const ok = await fetch(`${daemon.url}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: daemon.pairCode, deviceName: 'ok' }),
  });
  expect(ok.status).toBe(200);
});
