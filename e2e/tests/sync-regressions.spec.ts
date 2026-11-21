/**
 * Regressions for the ChatSync and PermissionReq bugs the TLA+ models found
 * (formal/README.md bugs 1, 2 and 6), driven over the websocket from the test
 * process. Each one checks the invariant the fix restored, so it holds in every
 * interleaving rather than depending on hitting a timing window.
 */
import { expect, test } from '../lib/fixtures.ts';
import type { Daemon } from '../lib/daemon.ts';
import { record } from '../lib/json.ts';
import { WsClient, type Frame } from '../lib/ws.ts';

async function newChat(daemon: Daemon, ws: WsClient): Promise<string> {
  const res = await ws.rpc({
    t: 'session.create',
    id: 'create',
    params: { kind: 'agent', agent: 'claude', cwd: daemon.project },
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return String(record(res['data'])['id']);
}

/** One full turn: subscribe, send, wait for the end-of-turn item. */
async function oneTurn(ws: WsClient, sessionId: string, text: string): Promise<void> {
  ws.send({ t: 'sub', sessionId });
  await ws.waitFor((f) => f.t === 'chat.snapshot' && f['sessionId'] === sessionId);
  await ws.rpc({ t: 'chat.send', id: `send-${text}`, sessionId, text });
  await ws.waitFor((f) => f.t === 'chat.item' && record(f['item'])['kind'] === 'turn', 20_000);
}

const snapshotSeq = async (ws: WsClient, sessionId: string): Promise<number> => {
  ws.send({ t: 'sub', sessionId });
  const snap = await ws.waitFor((f) => f.t === 'chat.snapshot' && f['sessionId'] === sessionId);
  return Number(snap['seq']);
};

function sessionInList(f: Frame, sessionId: string): Record<string, unknown> | undefined {
  const list = f['sessions'];
  return Array.isArray(list) ? list.map(record).find((s) => s['id'] === sessionId) : undefined;
}

// Bug 1: a restored session's jumped seq was not persisted, so a crash before
// the next write restored the same seqs again over a transcript that had moved on.
test('a seq handed out after a restart is never handed out again, even after a crash', async ({ daemon }) => {
  const token = await daemon.pairToken();
  const ws = await WsClient.connect(daemon, token);
  const id = await newChat(daemon, ws);
  await oneTurn(ws, id, 'first');
  ws.close();

  await daemon.restart();
  const a = await WsClient.connect(daemon, token);
  const seen = await snapshotSeq(a, id);
  a.close();
  await daemon.kill(); // nothing after the restart was written
  await daemon.restart();
  const b = await WsClient.connect(daemon, token);
  expect(await snapshotSeq(b, id)).toBeGreaterThan(seen);
  b.close();
});

// Bug 2: a `sub` that waited for a restored transcript to load finished after the
// client's `unsub` and put the connection back in the fanout.
test('an unsub sent while the transcript is still loading sticks', async ({ daemon }) => {
  const token = await daemon.pairToken();
  const ws = await WsClient.connect(daemon, token);
  const id = await newChat(daemon, ws);
  await oneTurn(ws, id, 'first');
  ws.close();
  await daemon.restart(); // the transcript is on disk only now

  const a = await WsClient.connect(daemon, token);
  // The chat screen mounts and unmounts at once (a quick back swipe).
  a.send({ t: 'sub', sessionId: id });
  a.send({ t: 'unsub', sessionId: id });
  // Another connection waits for the same load, then leaves too.
  const loader = await WsClient.connect(daemon, token);
  await snapshotSeq(loader, id);
  loader.send({ t: 'unsub', sessionId: id });
  loader.send({ t: 'ping' });
  await loader.waitFor((f) => f.t === 'pong');
  loader.close();
  const before = a.frames.length;

  const b = await WsClient.connect(daemon, token);
  const sessionsBefore = b.frames.length;
  await b.rpc({ t: 'chat.send', id: 'send-second', sessionId: id, text: 'second' });
  // Nobody is subscribed, so the finished turn leaves the session unread.
  await b.waitFor(
    (f) =>
      b.frames.indexOf(f) >= sessionsBefore &&
      f.t === 'sessions' &&
      sessionInList(f, id)?.['unread'] === true &&
      sessionInList(f, id)?.['status'] === 'idle',
    20_000,
  );
  const leaked = a.frames.slice(before).filter((f) => f.t.startsWith('chat.') && f['sessionId'] === id);
  expect(leaked).toEqual([]);
  a.close();
  b.close();
});

// Bug 6: a message sent while a permission card was pending flipped the session
// from `waiting` to `running` until the card was answered.
test('a message sent while a permission is pending keeps the session waiting', async ({ daemon }) => {
  const token = await daemon.pairToken();
  const ws = await WsClient.connect(daemon, token);
  const id = await newChat(daemon, ws);
  ws.send({ t: 'sub', sessionId: id });
  await ws.waitFor((f) => f.t === 'chat.snapshot');
  await ws.rpc({ t: 'chat.send', id: 's1', sessionId: id, text: 'run tests' });
  await ws.waitFor((f) => f.t === 'chat.item' && record(f['item'])['kind'] === 'permission', 20_000);
  await ws.waitFor((f) => f.t === 'sessions' && sessionInList(f, id)?.['status'] === 'waiting');

  await ws.rpc({ t: 'chat.send', id: 's2', sessionId: id, text: 'hello' });
  ws.send({ t: 'ping' });
  await ws.waitFor((f) => f.t === 'pong');
  // A fresh connection reads the current list.
  const fresh = await WsClient.connect(daemon, token);
  const list = await fresh.waitFor((f) => f.t === 'sessions');
  expect(sessionInList(list, id)?.['status']).toBe('waiting');
  fresh.close();
  ws.close();
});
