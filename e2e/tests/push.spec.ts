/**
 * Web Push: a subscription registered over the protocol receives an
 * encrypted notification when a session needs the user, and its decrypted
 * payload is exactly the protocol's `PushPayload`.
 */
import { execFileSync } from 'node:child_process';
import { createECDH, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { parse, record } from '../lib/json.ts';

// A local https "push service" with a self-signed certificate the daemon trusts.
const certDir = mkdtempSync(join(tmpdir(), 'phonecode-e2e-push-'));
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath,
], { stdio: 'pipe' }); // prettier-ignore

test.use({ daemonOptions: { env: { NODE_EXTRA_CA_CERTS: certPath } } });

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 8291 (aes128gcm) decryption on the user agent side. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    ua.getPublicKey(),
    asPublic,
    Buffer.from([1]),
  ]);
  const ikm = hmac(hmac(auth, ecdh), keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
  // Strip the padding delimiter (0x02) and any zero padding.
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

test('a session that needs the user sends a PushPayload notification', async ({ daemon }) => {
  const received: Buffer[] = [];
  const waiters: Array<() => void> = [];
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(201).end();
      for (const w of waiters.splice(0)) w();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const token = await daemon.pairToken();
  const ws = new WebSocket(`${daemon.url.replace('http', 'ws')}/ws`);
  const replies: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (e) => replies.push(record(parse(String(e.data)))));
  await new Promise((ok) => ws.addEventListener('open', ok));
  const rpc = async (msg: Record<string, unknown>): Promise<Record<string, unknown>> => {
    ws.send(JSON.stringify(msg));
    await expect.poll(() => replies.some((r) => r['id'] === msg['id'])).toBe(true);
    return replies.find((r) => r['id'] === msg['id']) ?? {};
  };
  ws.send(JSON.stringify({ t: 'hello', v: 1, token }));
  await expect.poll(() => replies.some((r) => r['t'] === 'ready')).toBe(true);
  const sub = await rpc({
    t: 'push.subscribe',
    id: 'p1',
    subscription: {
      endpoint: `https://localhost:${port}/push/abc`,
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  });
  expect(sub).toMatchObject({ ok: true });

  // A chat nobody is watching asks a question.
  const created = await rpc({
    t: 'session.create',
    id: 'c1',
    params: { kind: 'agent', agent: 'claude', cwd: daemon.project, title: 'Pushy' },
  });
  const sessionId = String(record(created['data'])['id']);
  const pushed = new Promise<void>((ok) => waiters.push(ok));
  await rpc({ t: 'chat.send', id: 's1', sessionId, text: 'ask me' });
  await pushed;
  ws.close();
  server.close();

  const payload = record(parse(decrypt(received[0] ?? Buffer.alloc(0), ua, auth)));
  expect(payload).toEqual({
    title: 'Pushy needs you',
    body: expect.stringContaining('Which package manager'),
    sessionId,
    tag: sessionId,
  });
});
