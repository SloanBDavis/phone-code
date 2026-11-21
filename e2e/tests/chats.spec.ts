/**
 * Protocol-level tests for the chat list: archiving, "All chats" search across
 * every harness with de-duplication against phone-code's own sessions, resuming
 * without duplicates, and slash commands. Driven over a raw websocket.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { REPO, type Daemon } from '../lib/daemon.ts';
import { isRecord, record } from '../lib/json.ts';
import { call, lastText, list, newChat, turn, waitSession } from '../lib/protocol.ts';
import { WsClient } from '../lib/ws.ts';

test.use({ daemonOptions: { env: { PHONECODE_GEMINI_BIN: join(REPO, 'e2e/fakes/fake-acp.mjs') } } });

async function connect(daemon: Daemon): Promise<WsClient> {
  return WsClient.connect(daemon, await daemon.pairToken());
}

async function history(ws: WsClient, query: Record<string, unknown>, agent?: string) {
  const data = await call(ws, { t: 'history.list', query, ...(agent === undefined ? {} : { agent }) });
  return (Array.isArray(data) ? data : []).map(record);
}

test('archive hides a chat, stops its agent, keeps the transcript; a message brings it back', async ({
  daemon,
}) => {
  const ws = await connect(daemon);
  const id = await newChat(ws, 'claude', daemon.folder('archive-me'));
  await turn(ws, id, 'hello, remember the word pelican');
  ws.send({ t: 'unsub', sessionId: id });

  const info = record(await call(ws, { t: 'session.archive', sessionId: id, archived: true }));
  expect(info).toMatchObject({ id, archived: true, unread: false, status: 'idle' });
  // Every phone sees it, flagged (the push still lists archived sessions).
  const other = await connect(daemon);
  expect(other.frames.find((f) => f.t === 'sessions')?.['sessions']).toEqual(
    expect.arrayContaining([expect.objectContaining({ id, archived: true })]),
  );

  // Sending un-archives; the agent resumes the same conversation.
  const items = await turn(other, id, 'still there?');
  expect(lastText(items)).toContain('You said: still there?');
  await waitSession(other, id, (s) => s['archived'] === undefined);
  other.send({ t: 'unsub', sessionId: id });
  const from = other.frames.length;
  other.send({ t: 'sub', sessionId: id });
  const snap = await other.waitFor(
    (f) => other.frames.indexOf(f) >= from && f.t === 'chat.snapshot' && f['sessionId'] === id,
  );
  const users = list(snap['items']).filter((i) => i['kind'] === 'user');
  expect(users.map((u) => u['text'])).toEqual(['hello, remember the word pelican', 'still there?']);

  // session.archive false also brings it back; unknown sessions fail.
  await call(ws, { t: 'session.archive', sessionId: id, archived: true });
  expect(
    record(await call(ws, { t: 'session.archive', sessionId: id, archived: false }))['archived'],
  ).toBeUndefined();
  const bad = await ws.rpc({ t: 'session.archive', id: 'x1', sessionId: 'nope', archived: true });
  expect(bad).toMatchObject({ ok: false, error: 'session not found' });
  ws.close();
  other.close();
});

test('an archived terminal keeps running', async ({ daemon }) => {
  const ws = await connect(daemon);
  const t = record(
    await call(ws, { t: 'session.create', params: { kind: 'terminal', cwd: daemon.project } }),
  );
  const id = String(t['id']);
  await call(ws, { t: 'session.archive', sessionId: id, archived: true });
  ws.send({ t: 'term.input', sessionId: id, data: 'echo still-$((40+2))\r' });
  ws.send({ t: 'sub', sessionId: id });
  await expect
    .poll(() =>
      ws.frames
        .filter((f) => f['sessionId'] === id && (f.t === 'term.snapshot' || f.t === 'term.data'))
        .map((f) => String(f['data']))
        .join(''),
    )
    .toContain('still-42');
  expect(ws.frames.some((f) => f.t === 'term.exit' && f['sessionId'] === id)).toBe(false);
  ws.close();
});

test('all chats: every harness, de-duplicated, searchable, paged; resuming reuses the session', async ({
  daemon,
}) => {
  // A conversation started at the computer, not through phone-code, with the
  // search word deep in the file (past the first 96 KB the old lister read).
  const projects = join(daemon.userHome, '.claude', 'projects', '-desk-project');
  mkdirSync(projects, { recursive: true });
  const filler = 'lorem ipsum '.repeat(2000);
  const lines = [
    {
      type: 'user',
      cwd: '/desk/project',
      uuid: 'a1',
      timestamp: '2026-01-01T10:00:00Z',
      message: { role: 'user', content: 'plan the release' },
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      type: 'assistant',
      uuid: `b${i}`,
      timestamp: '2026-01-01T10:01:00Z',
      message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: filler }] },
    })),
    {
      type: 'assistant',
      uuid: 'z',
      timestamp: '2026-01-01T10:02:00Z',
      message: {
        id: 'mz',
        role: 'assistant',
        content: [{ type: 'text', text: 'We should ship the xylophone build on Friday.' }],
      },
    },
  ];
  writeFileSync(
    join(projects, 'd0d0d0d0-1111-2222-3333-444444444444.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );

  const ws = await connect(daemon);
  const claude = await newChat(ws, 'claude', daemon.folder('all-claude'));
  await turn(ws, claude, 'remember the word giraffe');
  const codex = await newChat(ws, 'codex', daemon.folder('all-codex'));
  await turn(ws, codex, 'remember the word otter');
  const gemini = await newChat(ws, 'gemini', daemon.folder('all-gemini'));
  await turn(ws, gemini, 'remember the word walrus');

  const all = await history(ws, {});
  const mine = (sid: string) => all.filter((e) => e['sessionId'] === sid);
  for (const sid of [claude, codex, gemini]) expect(mine(sid)).toHaveLength(1); // once each, with sessionId
  expect(mine(claude)[0]).toMatchObject({ agent: 'claude', agentName: 'Claude Code' });
  expect(mine(gemini)[0]).toMatchObject({ agent: 'gemini', agentName: 'Gemini CLI' });
  const desk = all.find((e) => e['resumeId'] === 'd0d0d0d0-1111-2222-3333-444444444444');
  expect(desk).toMatchObject({ agent: 'claude', cwd: '/desk/project', title: 'plan the release' });
  expect(desk?.['sessionId']).toBeUndefined();
  const times = all.map((e) => Number(e['updatedAt']));
  expect(times).toEqual(times.toSorted((a, b) => b - a)); // newest first

  // Text search: message text, title and folder; with a snippet around the hit.
  const hit = await history(ws, { text: 'XYLOPHONE build' });
  expect(hit.map((e) => e['resumeId'])).toEqual(['d0d0d0d0-1111-2222-3333-444444444444']);
  expect(String(hit[0]?.['snippet'])).toContain('xylophone build');
  expect((await history(ws, { text: 'giraffe' })).map((e) => e['sessionId'])).toEqual([claude]);
  expect((await history(ws, { text: 'all-codex' })).map((e) => e['sessionId'])).toEqual([codex]);
  expect((await history(ws, { cwd: '/desk' })).map((e) => e['resumeId'])).toHaveLength(1);
  expect(await history(ws, { text: 'otter' }, 'claude')).toEqual([]);

  // Paging.
  const first = await history(ws, { limit: 2 });
  expect(first).toHaveLength(2);
  const rest = await history(ws, { limit: 200, before: Number(first[1]?.['updatedAt']) });
  expect(rest.map((e) => e['resumeId'])).not.toContain(first[0]?.['resumeId']);
  expect(first.length + rest.length).toBe(all.length);

  // Archived chats stay findable, flagged; a deleted one is just the agent's own history now.
  await call(ws, { t: 'session.archive', sessionId: claude, archived: true });
  await call(ws, { t: 'session.delete', sessionId: codex });
  const after = await history(ws, {});
  expect(after.find((e) => e['sessionId'] === claude)).toMatchObject({ archived: true });
  const otter = (await history(ws, { text: 'otter' }))[0];
  expect(otter).toMatchObject({ agent: 'codex' });
  expect(otter?.['sessionId']).toBeUndefined();

  // Continuing an archived chat from the list reuses (and un-archives) it.
  const entry = after.find((e) => e['sessionId'] === claude);
  const resumed = record(
    await call(ws, {
      t: 'session.create',
      params: { kind: 'agent', agent: 'claude', cwd: entry?.['cwd'], resumeId: entry?.['resumeId'] },
    }),
  );
  expect(resumed).toMatchObject({ id: claude });
  expect(resumed['archived']).toBeUndefined();
  // The older resume picker (no query) marks phone-code sessions too.
  const legacy = list(await call(ws, { t: 'history.list', agent: 'claude' }));
  expect(legacy.find((e) => e['resumeId'] === entry?.['resumeId'])).toMatchObject({
    sessionId: claude,
  });
  // Continuing a chat that is not in phone-code yet makes one new session, once.
  const before = (await history(ws, {})).length;
  const fresh = record(
    await call(ws, {
      t: 'session.create',
      params: { kind: 'agent', agent: 'codex', cwd: String(otter?.['cwd']), resumeId: otter?.['resumeId'] },
    }),
  );
  const again = record(
    await call(ws, {
      t: 'session.create',
      params: { kind: 'agent', agent: 'codex', cwd: String(otter?.['cwd']), resumeId: otter?.['resumeId'] },
    }),
  );
  expect(again['id']).toBe(fresh['id']);
  await expect
    .poll(async () => (await history(ws, { text: 'otter' })).map((e) => e['sessionId']))
    .toEqual([fresh['id']]);
  expect((await history(ws, {})).length).toBe(before);
  ws.close();
});

test('slash commands: listed per agent, and answered', async ({ daemon }) => {
  const ws = await connect(daemon);
  const ready = ws.frames.find((f) => f.t === 'ready');
  const catalog = list(record(ready?.['host'])['agentCatalog']);
  const names = (id: string) =>
    list(catalog.find((a) => a['id'] === id)?.['commands'] ?? []).map((c) => c['name']);
  expect(names('claude')).toEqual(expect.arrayContaining(['compact', 'usage', 'release-notes']));
  expect(names('codex')).toEqual(['compact', 'review']);

  // Claude: what the CLI's initialize response lists, with sources; `/cost` runs as a command.
  const c = await newChat(ws, 'claude', daemon.folder('cmd-claude'));
  await expect
    .poll(async () => list(await call(ws, { t: 'session.commands', sessionId: c })).length)
    .toBeGreaterThan(0);
  const cc = list(await call(ws, { t: 'session.commands', sessionId: c }));
  expect(cc).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'compact',
        source: 'builtin',
        argumentHint: '<optional custom summarization instructions>',
      }),
      expect.objectContaining({ name: 'release-notes', source: 'user', description: 'Write release notes' }),
      expect.objectContaining({ name: 'deploy', source: 'project', description: 'Deploy this project' }),
    ]),
  );
  expect(cc.map((x) => x['name'])).not.toContain('__internal');
  const cost = await turn(ws, c, '/cost');
  expect(lastText(cost)).toContain('Estimated cost');
  expect(cost.find((i) => i['kind'] === 'turn')).toMatchObject({ outcome: 'completed' });

  // Codex: built-ins mapped onto app-server methods, plus skills/list.
  const x = await newChat(ws, 'codex', daemon.folder('cmd-codex'));
  await expect
    .poll(async () =>
      list(await call(ws, { t: 'session.commands', sessionId: x })).map((v) => record(v)['name']),
    )
    .toEqual(['compact', 'review', 'release-notes']);
  const compact = await turn(ws, x, '/compact');
  expect(compact.find((i) => i['kind'] === 'notice')).toMatchObject({ text: 'Conversation compacted' });
  expect(lastText(await turn(ws, x, '/release-notes v2'))).toContain('You said: $release-notes v2');

  // ACP: available_commands_update; `/help` goes to the agent as a prompt.
  const g = await newChat(ws, 'gemini', daemon.folder('cmd-gemini'));
  await expect
    .poll(async () =>
      list(await call(ws, { t: 'session.commands', sessionId: g })).map((v) => record(v)['name']),
    )
    .toEqual(['init', 'help', 'review']);
  const gc = list(await call(ws, { t: 'session.commands', sessionId: g }));
  expect(gc[2]).toMatchObject({ name: 'review', argumentHint: 'what to focus on' });
  expect(lastText(await turn(ws, g, '/help'))).toContain('Commands: /init, /help, /review');

  // A terminal has none; an unknown session is an error.
  const t = record(
    await call(ws, { t: 'session.create', params: { kind: 'terminal', cwd: daemon.project } }),
  );
  expect(await call(ws, { t: 'session.commands', sessionId: t['id'] })).toEqual([]);
  expect(await ws.rpc({ t: 'session.commands', id: 'nope', sessionId: 'nope' })).toMatchObject({ ok: false });
  ws.close();
});

test('setup hints and connection info in the host description', async ({ daemon }) => {
  const ws = await connect(daemon);
  const host = record(ws.frames.find((f) => f.t === 'ready')?.['host']);
  expect(host['connection']).toEqual({ mode: 'local', secure: true });
  const catalog = list(host['agentCatalog']);
  for (const a of catalog.filter((x) => x['id'] === 'claude' || x['id'] === 'codex' || x['id'] === 'gemini'))
    expect(a['setupHint'], String(a['id'])).toBeUndefined();
  // Presets not installed here explain themselves.
  const missing = catalog.filter((a) => a['available'] === false);
  expect(missing.length).toBeGreaterThan(0);
  for (const a of missing) expect(String(a['setupHint'])).toContain('Not installed');
  ws.close();

  await daemon
    .relaunch({ env: { FAKE_CLAUDE_LOGGED_OUT: '1', FAKE_CODEX_LOGGED_OUT: '1' } })
    .then((r) => r.ready);
  const again = await connect(daemon);
  const cat2 = list(record(again.frames.find((f) => f.t === 'ready')?.['host'])['agentCatalog']);
  const hint = (id: string) => cat2.find((a) => a['id'] === id)?.['setupHint'];
  expect(hint('claude')).toContain('claude auth login');
  expect(hint('codex')).toContain('codex login');
  again.close();
  expect(isRecord(host)).toBe(true);
});
