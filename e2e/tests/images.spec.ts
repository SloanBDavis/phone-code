/**
 * Images, at the protocol level: sending (stored, sniffed, passed to each
 * agent in its own form), viewing (agent output extracted into refs, local
 * markdown links confined to the session folder) and the authenticated
 * GET /api/sessions/<id>/images/<imageId> endpoint.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test } from '../lib/fixtures.ts';
import { REPO, type Daemon } from '../lib/daemon.ts';
import { record } from '../lib/json.ts';
import { callFails, lastText, list, newChat, turn } from '../lib/protocol.ts';
import { WsClient } from '../lib/ws.ts';

test.use({ daemonOptions: { env: { PHONECODE_GEMINI_BIN: join(REPO, 'e2e/fakes/fake-acp.mjs') } } });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A solid-colour RGB PNG. */
function png(width: number, height: number, rgb: [number, number, number] = [200, 40, 90]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

function imageUrl(daemon: Daemon, sessionId: string, id: string, w?: number): string {
  return `${daemon.url}/api/sessions/${sessionId}/images/${id}${w === undefined ? '' : `?w=${w}`}`;
}

function rawGet(daemon: Daemon, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: daemon.port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

test('sending images: stored once, sniffed, served with auth, passed to each agent', async ({ daemon }) => {
  const token = await daemon.pairToken();
  const ws = await WsClient.connect(daemon, token);
  const auth = { authorization: `Bearer ${token}` };
  const photo = png(300, 200);

  const c = await newChat(ws, 'claude', daemon.folder('img-claude'));
  const items = await turn(ws, c, 'what is this', [
    { mediaType: 'image/png', name: 'photo.png', data: photo.toString('base64') },
  ]);
  const user = items.find((i) => i['kind'] === 'user');
  expect(user?.['attachments']).toBeUndefined(); // no inline bytes in transcripts
  const ref = record(list(user?.['images'])[0]);
  expect(ref).toMatchObject({
    mediaType: 'image/png',
    name: 'photo.png',
    width: 300,
    height: 200,
    bytes: photo.length,
  });
  expect(lastText(items)).toContain('[with 1 image(s): image/png]'); // a Claude image content block

  const got = await fetch(imageUrl(daemon, c, String(ref['id'])), { headers: auth });
  expect(got.status).toBe(200);
  expect(got.headers.get('content-type')).toBe('image/png');
  expect(got.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  expect(Buffer.from(await got.arrayBuffer()).equals(photo)).toBe(true);
  const etag = got.headers.get('etag') ?? '';
  expect(
    (await fetch(imageUrl(daemon, c, String(ref['id'])), { headers: { ...auth, 'if-none-match': etag } }))
      .status,
  ).toBe(304);

  // A thumbnail made with Bun.Image.
  const thumb = await fetch(imageUrl(daemon, c, String(ref['id']), 100), { headers: auth });
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get('content-type')).toBe('image/webp');
  expect((await thumb.arrayBuffer()).byteLength).toBeLessThan(photo.length);

  // Authorization and confinement of the route.
  const id = String(ref['id']);
  expect((await fetch(imageUrl(daemon, c, id))).status).toBe(401);
  expect(
    (await fetch(imageUrl(daemon, c, id), { headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status,
  ).toBe(401);
  const other = await newChat(ws, 'claude', daemon.project);
  expect((await fetch(imageUrl(daemon, other, id), { headers: auth })).status).toBe(404); // per session
  expect((await fetch(imageUrl(daemon, 'nope', id), { headers: auth })).status).toBe(404);
  expect(await rawGet(daemon, `/api/sessions/${c}/images/../../devices.json`, auth)).toBe(404);
  expect(await rawGet(daemon, `/api/sessions/..%2F..%2Fdevices.json/images/${id}`, auth)).toBe(404);
  expect((await fetch(imageUrl(daemon, c, id, 99_999), { headers: auth })).status).toBe(400);
  // Same transport rules as every /api route: plain http through a proxy is refused.
  expect(
    await rawGet(daemon, `/api/sessions/${c}/images/${id}`, { ...auth, 'x-forwarded-proto': 'http' }),
  ).toBe(403);

  // The type comes from the bytes, not the label; non-images are refused.
  const gif = await turn(ws, c, 'a gif', [{ mediaType: 'image/png', data: GIF.toString('base64') }]);
  expect(record(list(gif.find((i) => i['kind'] === 'user')?.['images'])[0])).toMatchObject({
    mediaType: 'image/gif',
  });
  const refused = await callFails(ws, {
    t: 'chat.send',
    sessionId: c,
    text: 'not really',
    attachments: [{ mediaType: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') }],
  });
  expect(refused).toContain('not a PNG, JPEG, GIF or WebP');

  // Codex gets the stored file as a local image; ACP agents get image content.
  const x = await newChat(ws, 'codex', daemon.folder('img-codex'));
  const cx = await turn(ws, x, 'look', [{ mediaType: 'image/png', data: photo.toString('base64') }]);
  expect(lastText(cx)).toContain(`[with 1 image(s): localImage png ${photo.length}b]`);
  const g = await newChat(ws, 'gemini', daemon.folder('img-gemini'));
  expect(
    lastText(await turn(ws, g, 'look', [{ mediaType: 'image/jpeg', data: photo.toString('base64') }])),
  ).toContain('[with 1 image(s): image/png]');
  ws.close();
});

test('viewing images: tool results and local files linked in replies, confined to the session folder', async ({
  daemon,
}) => {
  const token = await daemon.pairToken();
  const ws = await WsClient.connect(daemon, token);
  const auth = { authorization: `Bearer ${token}` };
  const folder = daemon.folder('img-view');
  const cwd = join(daemon.userHome, folder);
  const c = await newChat(ws, 'claude', folder);

  // A Read of an image file: the tool result's image block becomes a ref on the tool item.
  const shot = await turn(ws, c, 'take a screenshot');
  const tool = shot.find((i) => i['kind'] === 'tool' && i['name'] === 'Read');
  const tref = record(list(tool?.['images'])[0]);
  expect(tref).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 });
  expect((await fetch(imageUrl(daemon, c, String(tref['id'])), { headers: auth })).status).toBe(200);

  // Local files the reply links to: only real files inside the session folder.
  writeFileSync(join(cwd, 'chart.png'), png(4, 4, [1, 2, 3]));
  mkdirSync(join(daemon.userHome, 'secret'), { recursive: true });
  writeFileSync(join(daemon.userHome, 'secret', 'private.png'), png(4, 4, [9, 9, 9]));
  symlinkSync(join(daemon.userHome, 'secret', 'private.png'), join(cwd, 'link.png'));
  writeFileSync(join(cwd, 'fake.png'), 'not an image');
  const text =
    'see ![a](chart.png) ![b](link.png) ![c](../secret/private.png) ![d](fake.png) `/etc/hostname.png` ![e](https://example.com/x.png)';
  const from = ws.frames.length;
  await turn(ws, c, text);
  const withImages = await ws.waitFor(
    (f) =>
      ws.frames.indexOf(f) >= from &&
      f.t === 'chat.item' &&
      record(f['item'])['kind'] === 'text' &&
      Array.isArray(record(f['item'])['images']),
  );
  const refs = list(record(withImages['item'])['images']);
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({ name: 'chart.png', mediaType: 'image/png', width: 4 });
  // The refs survive the snapshot a new subscriber gets.
  const fresh = await WsClient.connect(daemon, token);
  fresh.send({ t: 'sub', sessionId: c });
  const snap = await fresh.waitFor((f) => f.t === 'chat.snapshot');
  const texts = list(snap['items'])
    .map(record)
    .filter((i) => i['kind'] === 'text' && Array.isArray(i['images']));
  expect(texts).toHaveLength(1);
  ws.close();
  fresh.close();
});
