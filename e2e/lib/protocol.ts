/** Helpers for protocol-level tests: rpc calls and whole turns over a raw WsClient. */
import { expect } from '@playwright/test';
import { isRecord, record } from './json.ts';
import type { Frame, WsClient } from './ws.ts';

let seq = 0;
const nextId = (p: string): string => `${p}-${++seq}`;

/** An rpc that must succeed; its `data`. */
export async function call(ws: WsClient, msg: Record<string, unknown>): Promise<unknown> {
  const res = await ws.rpc({ ...msg, id: nextId(String(msg['t'])) });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res['data'];
}

/** An rpc that must fail; its error text. */
export async function callFails(ws: WsClient, msg: Record<string, unknown>): Promise<string> {
  const res = await ws.rpc({ ...msg, id: nextId(String(msg['t'])) });
  expect(res['ok'], JSON.stringify(res)).toBe(false);
  return String(res['error']);
}

export async function newChat(
  ws: WsClient,
  agent: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const info = record(
    await call(ws, { t: 'session.create', params: { kind: 'agent', agent, cwd, ...extra } }),
  );
  return String(info['id']);
}

export function item(f: Frame): Record<string, unknown> {
  return record(f['item']);
}

/** Frames for `sessionId` that arrived after index `from`. */
export function itemsSince(ws: WsClient, sessionId: string, from: number): Array<Record<string, unknown>> {
  return ws.frames
    .slice(from)
    .filter((f) => f.t === 'chat.item' && f['sessionId'] === sessionId)
    .map(item);
}

/**
 * Subscribe (once), send `text`, wait for the turn's end. Returns the items
 * upserted during the turn (latest state per id, in order).
 */
export async function turn(
  ws: WsClient,
  sessionId: string,
  text: string,
  attachments?: unknown[],
): Promise<Array<Record<string, unknown>>> {
  if (!ws.frames.some((f) => f.t === 'chat.snapshot' && f['sessionId'] === sessionId)) {
    ws.send({ t: 'sub', sessionId });
    await ws.waitFor((f) => f.t === 'chat.snapshot' && f['sessionId'] === sessionId);
  }
  const from = ws.frames.length;
  await call(ws, { t: 'chat.send', sessionId, text, ...(attachments === undefined ? {} : { attachments }) });
  await ws.waitFor(
    (f) =>
      ws.frames.indexOf(f) >= from &&
      f.t === 'chat.item' &&
      f['sessionId'] === sessionId &&
      item(f)['kind'] === 'turn',
    20_000,
  );
  const latest = new Map<string, Record<string, unknown>>();
  for (const it of itemsSince(ws, sessionId, from)) latest.set(String(it['id']), it);
  return [...latest.values()];
}

/** `v` as a list of records (throws unless it is an array of objects). */
export function list(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) throw new Error(`expected an array, got ${JSON.stringify(v)}`);
  return v.map(record);
}

/** The text of the last text item in `items`. */
export function lastText(items: Array<Record<string, unknown>>): string {
  const t = items.findLast((i) => i['kind'] === 'text')?.['text'];
  return typeof t === 'string' ? t : '';
}

/** The latest `sessions` push. */
export function latestSessions(ws: WsClient): Array<Record<string, unknown>> {
  const f = ws.frames.findLast((x) => x.t === 'sessions');
  const sessions = f?.['sessions'];
  return Array.isArray(sessions) ? sessions.filter(isRecord) : [];
}

/** Waits until the latest `sessions` push has `sessionId` matching `pred`. */
export async function waitSession(
  ws: WsClient,
  sessionId: string,
  pred: (s: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  await expect
    .poll(() => {
      const s = latestSessions(ws).find((x) => x['id'] === sessionId);
      return s !== undefined && pred(s);
    })
    .toBe(true);
  const s = latestSessions(ws).find((x) => x['id'] === sessionId);
  return record(s);
}
