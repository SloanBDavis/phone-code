/**
 * Hand-written validation for inbound client frames. Every accepted message
 * is rebuilt field by field, so unknown properties never reach the core.
 */
import type {
  AgentId,
  Attachment,
  ClientMessage,
  CreateSessionParams,
  HistoryQuery,
  PermissionDecision,
  PermissionMode,
  SessionKind,
} from '@phone-code/protocol';
import { isRecord, parseJson } from './util/guards.ts';

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (!isRecord(v)) throw new Invalid(`${what} must be an object`);
  return v;
}

function str(o: Obj, key: string, max: number, min = 0): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Invalid(`${key} must be a string`);
  if (v.length > max || v.length < min) throw new Invalid(`${key} has invalid length`);
  return v;
}

function optStr(o: Obj, key: string, max: number): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : str(o, key, max);
}

function int(o: Obj, key: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new Invalid(`${key} out of range`);
  return v;
}

function optInt(o: Obj, key: string, min: number, max: number): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : int(o, key, min, max);
}

function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const v = o[key];
  const found = values.find((x) => x === v);
  if (found === undefined) throw new Invalid(`${key} must be one of ${values.join(', ')}`);
  return found;
}

function optOneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T | undefined {
  return o[key] === undefined || o[key] === null ? undefined : oneOf(o, key, values);
}

/** Native kinds and ACP agent ids share one shape (see AgentId); the manager checks the id is known. */
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function optAgent(o: Obj, key: string): AgentId | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !AGENT_ID.test(v)) throw new Invalid(`${key} must be an agent id`);
  return v;
}
const KINDS: readonly SessionKind[] = ['terminal', 'agent'];
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const DECISIONS: readonly PermissionDecision[] = ['allow', 'allowAlways', 'deny'];

const ID_MAX = 128;
const TEXT_MAX = 1_000_000;
const ATTACHMENT_MAX = 15_000_000; // base64 chars

function stringRecord(v: unknown, what: string): Record<string, string> {
  const o = obj(v, what);
  const out: Record<string, string> = {};
  const keys = Object.keys(o);
  if (keys.length > 100) throw new Invalid(`${what} has too many entries`);
  for (const k of keys) out[k] = str(o, k, 10_000);
  return out;
}

function attachments(v: unknown): Attachment[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 10) throw new Invalid('attachments must be an array of at most 10');
  let total = 0;
  return v.map((raw: unknown) => {
    const a = obj(raw, 'attachment');
    const data = str(a, 'data', ATTACHMENT_MAX);
    total += data.length;
    if (total > ATTACHMENT_MAX * 2) throw new Invalid('attachments too large');
    const name = optStr(a, 'name', 256);
    return { mediaType: str(a, 'mediaType', 128, 1), data, ...(name === undefined ? {} : { name }) };
  });
}

function historyQuery(v: unknown): HistoryQuery | undefined {
  if (v === undefined || v === null) return undefined;
  const q = obj(v, 'query');
  const out: HistoryQuery = {};
  const text = optStr(q, 'text', 500);
  if (text !== undefined && text.trim() !== '') out.text = text;
  const cwd = optStr(q, 'cwd', 4096);
  if (cwd !== undefined && cwd !== '') out.cwd = cwd;
  const limit = optInt(q, 'limit', 1, 200);
  if (limit !== undefined) out.limit = limit;
  const before = optInt(q, 'before', 0, Number.MAX_SAFE_INTEGER);
  if (before !== undefined) out.before = before;
  return out;
}

function createParams(v: unknown): CreateSessionParams {
  const p = obj(v, 'params');
  const out: CreateSessionParams = { kind: oneOf(p, 'kind', KINDS) };
  const agent = optAgent(p, 'agent');
  if (out.kind === 'agent' && agent === undefined) throw new Invalid('agent is required for agent sessions');
  if (agent !== undefined) out.agent = agent;
  const cwd = optStr(p, 'cwd', 4096);
  if (cwd !== undefined) out.cwd = cwd;
  const title = optStr(p, 'title', 200);
  if (title !== undefined) out.title = title;
  const model = optStr(p, 'model', 200);
  if (model !== undefined) out.model = model;
  const effort = optStr(p, 'effort', 64);
  if (effort !== undefined) out.effort = effort;
  const mode = optOneOf(p, 'permissionMode', MODES);
  if (mode !== undefined) out.permissionMode = mode;
  const resumeId = optStr(p, 'resumeId', 512);
  if (resumeId !== undefined) out.resumeId = resumeId;
  const cols = optInt(p, 'cols', 2, 1000);
  if (cols !== undefined) out.cols = cols;
  const rows = optInt(p, 'rows', 2, 500);
  if (rows !== undefined) out.rows = rows;
  const command = optStr(p, 'command', 8192);
  if (command !== undefined) out.command = command;
  return out;
}

function parseObject(o: Obj): ClientMessage {
  const t = o['t'];
  switch (t) {
    case 'hello':
      return { t, v: int(o, 'v', 0, 1_000_000), token: str(o, 'token', 512) };
    case 'ping':
      return { t };
    case 'session.create':
      return { t, id: str(o, 'id', ID_MAX, 1), params: createParams(o['params']) };
    case 'session.rename':
      return {
        t,
        id: str(o, 'id', ID_MAX, 1),
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        title: str(o, 'title', 200, 1),
      };
    case 'session.delete':
      return { t, id: str(o, 'id', ID_MAX, 1), sessionId: str(o, 'sessionId', ID_MAX, 1) };
    case 'cursor.connect':
    case 'cursor.disconnect':
      return { t, id: str(o, 'id', ID_MAX, 1) };
    case 'fs.list': {
      const path = optStr(o, 'path', 4096);
      return { t, id: str(o, 'id', ID_MAX, 1), ...(path === undefined ? {} : { path }) };
    }
    case 'history.list': {
      const agent = optAgent(o, 'agent');
      const query = historyQuery(o['query']);
      return {
        t,
        id: str(o, 'id', ID_MAX, 1),
        ...(agent === undefined ? {} : { agent }),
        ...(query === undefined ? {} : { query }),
      };
    }
    case 'session.archive': {
      const archived = o['archived'];
      if (typeof archived !== 'boolean') throw new Invalid('archived must be a boolean');
      return { t, id: str(o, 'id', ID_MAX, 1), sessionId: str(o, 'sessionId', ID_MAX, 1), archived };
    }
    case 'session.commands':
      return { t, id: str(o, 'id', ID_MAX, 1), sessionId: str(o, 'sessionId', ID_MAX, 1) };
    case 'sub': {
      const afterSeq = optInt(o, 'afterSeq', 0, Number.MAX_SAFE_INTEGER);
      return {
        t,
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        ...(afterSeq === undefined ? {} : { afterSeq }),
      };
    }
    case 'unsub':
      return { t, sessionId: str(o, 'sessionId', ID_MAX, 1) };
    case 'chat.send': {
      const att = attachments(o['attachments']);
      return {
        t,
        id: str(o, 'id', ID_MAX, 1),
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        text: str(o, 'text', TEXT_MAX),
        ...(att === undefined ? {} : { attachments: att }),
      };
    }
    case 'chat.interrupt':
      return { t, sessionId: str(o, 'sessionId', ID_MAX, 1) };
    case 'chat.permission': {
      const message = optStr(o, 'message', 10_000);
      return {
        t,
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        itemId: str(o, 'itemId', ID_MAX, 1),
        decision: oneOf(o, 'decision', DECISIONS),
        ...(message === undefined ? {} : { message }),
      };
    }
    case 'chat.answer':
      return {
        t,
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        itemId: str(o, 'itemId', ID_MAX, 1),
        answers: stringRecord(o['answers'], 'answers'),
      };
    case 'chat.setMode':
      return {
        t,
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        permissionMode: oneOf(o, 'permissionMode', MODES),
      };
    case 'chat.setModel':
      return { t, sessionId: str(o, 'sessionId', ID_MAX, 1), model: str(o, 'model', 200, 1) };
    case 'chat.setEffort':
      return { t, sessionId: str(o, 'sessionId', ID_MAX, 1), effort: str(o, 'effort', 64, 1) };
    case 'term.input':
      return { t, sessionId: str(o, 'sessionId', ID_MAX, 1), data: str(o, 'data', 1_000_000) };
    case 'term.resize':
      return {
        t,
        sessionId: str(o, 'sessionId', ID_MAX, 1),
        cols: int(o, 'cols', 2, 1000),
        rows: int(o, 'rows', 2, 500),
      };
    case 'push.subscribe':
      return { t, id: str(o, 'id', ID_MAX, 1), subscription: o['subscription'] };
    case 'push.unsubscribe':
      return { t, id: str(o, 'id', ID_MAX, 1), endpoint: str(o, 'endpoint', 2048, 1) };
    default:
      throw new Invalid(`unknown message type`);
  }
}

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string; id?: string };

/** Parse one text frame. Never throws. */
export function parseClientFrame(text: string): ParseResult {
  const o = parseJson(text);
  if (o === undefined) return { ok: false, error: 'invalid JSON' };
  if (!isRecord(o)) return { ok: false, error: 'frame must be an object' };
  try {
    return { ok: true, msg: parseObject(o) };
  } catch (err) {
    const id = typeof o['id'] === 'string' && o['id'].length <= ID_MAX ? o['id'] : undefined;
    const error = err instanceof Invalid ? err.message : 'invalid message';
    return { ok: false, error, ...(id === undefined ? {} : { id }) };
  }
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function parsePushSubscription(v: unknown): PushSubscriptionInput | undefined {
  try {
    const o = obj(v, 'subscription');
    const endpoint = str(o, 'endpoint', 2048, 8);
    if (!endpoint.startsWith('https://')) return undefined;
    const keys = obj(o['keys'], 'keys');
    return { endpoint, keys: { p256dh: str(keys, 'p256dh', 256, 16), auth: str(keys, 'auth', 128, 8) } };
  } catch {
    return undefined;
  }
}
