#!/usr/bin/env bun
// Scripted stand-in for `codex app-server` (see README.md): JSON-RPC 2.0 over
// stdio, one object per line, no "jsonrpc" field, notifications carry
// `emittedAtMs`. Shapes follow `codex app-server generate-ts` of codex-cli
// 0.171.0 and the framing of the real binary. Dependency-free; bun or node.
/* oxlint-disable no-await-in-loop -- a scripted agent streams sequentially on purpose */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.171.0\n');
  process.exit(0);
}
if (argv[0] !== 'app-server') {
  process.stderr.write('fake-codex only implements `app-server`\n');
  process.exit(2);
}

const speed = Number(process.env.FAKE_SPEED ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const MODELS = ['gpt-fake-codex', 'gpt-fake-mini'];
const nowS = () => Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- output
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const result = (id, res) => send({ id, result: res });
const rpcError = (id, message, code = -32600) => send({ error: { code, message }, id });

// ---------------------------------------------------------------- state
/** @type {{id: string, cwd: string, model: string, approvalPolicy: string, sandbox: string, file: string, turns: any[], createdAt: number, preview: string} | null} */
let thread = null;
let current = null; // { turn, aborted, onAbort: Set }
let nextServerId = 1;
const serverWaiters = new Map();
const sessionGrants = new Set();
let tokens = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

function threadObj() {
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: thread.preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: thread.model,
    reasoningEffort: null,
    createdAt: thread.createdAt,
    updatedAt: nowS(),
    recencyAt: nowS(),
    status: { type: current ? 'active' : 'idle', ...(current ? { activeFlags: [] } : {}) },
    path: thread.file,
    cwd: thread.cwd,
    cliVersion: '0.171.0',
    originator: 'phone_code',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function threadResponse() {
  return {
    thread: threadObj(),
    model: thread.model,
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: {
      type:
        thread.sandbox === 'read-only'
          ? 'readOnly'
          : thread.sandbox === 'danger-full-access'
            ? 'dangerFullAccess'
            : 'workspaceWrite',
    },
    reasoningEffort: null,
  };
}

function appendRollout(entry) {
  try {
    fs.mkdirSync(path.dirname(thread.file), { recursive: true });
    fs.appendFileSync(thread.file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // ignore
  }
}

function findRollout(id) {
  const root = path.join(codexHome, 'sessions');
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (e.name.endsWith(`${id}.jsonl`)) return p;
    }
    return undefined;
  };
  return walk(root);
}

// ----------------------------------------------------------------- input
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    onMessage(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(143));

function onMessage(msg) {
  if (msg.method === undefined && msg.id !== undefined) {
    const w = serverWaiters.get(msg.id);
    if (w) {
      serverWaiters.delete(msg.id);
      w(msg.result ?? { error: msg.error });
    }
    return;
  }
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize':
      return result(msg.id, {
        userAgent: `${p.clientInfo?.name ?? 'client'}/0.171.0 (fake)`,
        codexHome,
        platformFamily: 'unix',
        platformOs: process.platform === 'darwin' ? 'macos' : 'linux',
      });
    case 'initialized':
      return undefined;
    case 'thread/start': {
      const id = randomUUID();
      const d = new Date();
      const dir = path.join(
        codexHome,
        'sessions',
        String(d.getFullYear()),
        pad(d.getMonth() + 1),
        pad(d.getDate()),
      );
      const stamp = d.toISOString().replace(/:/g, '-').slice(0, 19);
      thread = {
        id,
        cwd: p.cwd ?? process.cwd(),
        model: p.model ?? MODELS[0],
        approvalPolicy: p.approvalPolicy ?? 'on-request',
        sandbox: p.sandbox ?? 'workspace-write',
        file: path.join(dir, `rollout-${stamp}-${id}.jsonl`),
        turns: [],
        createdAt: nowS(),
        preview: '',
      };
      appendRollout({
        type: 'session_meta',
        payload: {
          id,
          session_id: id,
          timestamp: d.toISOString(),
          cwd: thread.cwd,
          originator: 'phone_code',
          cli_version: '0.171.0',
          source: 'vscode',
          model_provider: 'openai',
        },
      });
      result(msg.id, threadResponse());
      return notify('thread/started', { thread: threadObj() });
    }
    case 'thread/resume': {
      const file = findRollout(p.threadId);
      if (!file) return rpcError(msg.id, `no rollout found for thread id ${p.threadId}`);
      const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const meta = lines.find((l) => l.type === 'session_meta')?.payload ?? {};
      const turns = lines.filter((l) => l.type === 'phonecode_fake_turn').map((l) => l.payload);
      const firstUser = turns[0]?.items?.find((i) => i.type === 'userMessage')?.content?.[0]?.text ?? '';
      thread = {
        id: p.threadId,
        cwd: p.cwd ?? meta.cwd ?? process.cwd(),
        model: p.model ?? MODELS[0],
        approvalPolicy: p.approvalPolicy ?? 'on-request',
        sandbox: p.sandbox ?? 'workspace-write',
        file,
        turns,
        createdAt: nowS(),
        preview: firstUser,
      };
      result(msg.id, {
        ...threadResponse(),
        collaborationMode: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      });
      return notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } });
    }
    case 'thread/turns/list': {
      if (!thread || thread.id !== p.threadId) return rpcError(msg.id, 'thread not loaded');
      const list = p.sortDirection === 'desc' ? thread.turns.toReversed() : thread.turns;
      return result(msg.id, { data: list.slice(0, p.limit ?? 50), nextCursor: null, backwardsCursor: null });
    }
    case 'model/list':
      return result(msg.id, {
        data: MODELS.map((m, i) => ({
          id: m,
          model: m,
          displayName: m,
          description: 'fake',
          hidden: false,
          isDefault: i === 0,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'low',
          inputModalities: ['text', 'image'],
        })),
        nextCursor: null,
      });
    case 'turn/start': {
      if (!thread || thread.id !== p.threadId) return rpcError(msg.id, 'thread not found');
      if (current) return rpcError(msg.id, 'a turn is already running');
      if (p.approvalPolicy) thread.approvalPolicy = p.approvalPolicy;
      if (p.model) thread.model = p.model;
      if (p.sandboxPolicy?.type)
        thread.sandbox =
          { readOnly: 'read-only', dangerFullAccess: 'danger-full-access' }[p.sandboxPolicy.type] ??
          'workspace-write';
      const turn = {
        id: randomUUID(),
        rootTurnId: null,
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      turn.rootTurnId = turn.id;
      result(msg.id, { turn: { ...turn, itemsView: 'notLoaded' } });
      void runTurn(turn, p.input ?? []);
      return undefined;
    }
    case 'turn/interrupt': {
      if (!current || current.turn.id !== p.turnId) return rpcError(msg.id, 'no active turn to interrupt');
      current.aborted = true;
      for (const fn of current.onAbort) fn();
      return result(msg.id, {});
    }
    case 'thread/list':
      return result(msg.id, { data: [], nextCursor: null, backwardsCursor: null });
    default:
      if (msg.id !== undefined) return rpcError(msg.id, `unknown method ${msg.method}`, -32601);
      return undefined;
  }
}

/** Server -> client request; resolves with the client's result (or {cancelled:true} on interrupt). */
function ask(method, params) {
  const id = nextServerId++;
  send({ id, method, params });
  return new Promise((resolve) => {
    const cancel = () => {
      serverWaiters.delete(id);
      notify('serverRequest/resolved', { threadId: thread.id, requestId: id });
      resolve({ cancelled: true });
    };
    current.onAbort.add(cancel);
    serverWaiters.set(id, (res) => {
      current.onAbort.delete(cancel);
      notify('serverRequest/resolved', { threadId: thread.id, requestId: id });
      resolve(res);
    });
  });
}

// ---------------------------------------------------------------- turns
class Interrupted extends Error {}

function ctx(turn) {
  const base = { threadId: thread.id, turnId: turn.id };
  const c = {
    check() {
      if (current.aborted) throw new Interrupted();
    },
    started(item) {
      notify('item/started', {
        item: { ...item, startedAtMs: Date.now(), completedAtMs: null },
        ...base,
        startedAtMs: Date.now(),
      });
    },
    completed(item) {
      const full = { ...item, startedAtMs: item.startedAtMs ?? Date.now(), completedAtMs: Date.now() };
      turn.items.push(full);
      notify('item/completed', { item: full, ...base, completedAtMs: Date.now() });
    },
    async message(text, delay = 30) {
      const id = `msg_${randomUUID()}`;
      const item = {
        type: 'agentMessage',
        id,
        text: '',
        phase: null,
        moderation: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      c.started(item);
      let sent = '';
      try {
        for (const w of text.match(/\S+\s*|\s+/g) ?? []) {
          c.check();
          await sleep(delay);
          c.check();
          sent += w;
          notify('item/agentMessage/delta', { ...base, itemId: id, delta: w });
        }
      } finally {
        c.completed({ ...item, text: sent });
      }
    },
    async reasoning(text) {
      const id = `rs_${randomUUID()}`;
      c.started({ type: 'reasoning', id, summary: [], content: [] });
      notify('item/reasoning/summaryPartAdded', { ...base, itemId: id, summaryIndex: 0 });
      for (const w of text.match(/\S+\s*/g) ?? []) {
        c.check();
        await sleep(15);
        notify('item/reasoning/summaryTextDelta', { ...base, itemId: id, delta: w, summaryIndex: 0 });
      }
      c.completed({ type: 'reasoning', id, summary: [text], content: [] });
    },
    usage(input, output) {
      const last = {
        inputTokens: input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
        totalTokens: input + output,
      };
      tokens = {
        inputTokens: tokens.inputTokens + input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: tokens.outputTokens + output,
        reasoningOutputTokens: 0,
        totalTokens: tokens.totalTokens + input + output,
      };
      notify('thread/tokenUsage/updated', {
        ...base,
        tokenUsage: { total: tokens, last, modelContextWindow: 272000 },
      });
    },
  };
  return c;
}

const needsApproval = (kind) => {
  if (thread.approvalPolicy === 'never') return false;
  if (sessionGrants.has(kind)) return false;
  if (kind === 'edit' && thread.approvalPolicy === 'on-request' && thread.sandbox !== 'read-only')
    return false;
  return true;
};

async function command(c, turn, cmd, { output, exitCode = 0, approval = true }) {
  const id = `call_${randomUUID()}`;
  const item = {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: `/bin/bash -lc '${cmd}'`,
    cwd: thread.cwd,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [{ type: 'unknown', command: cmd }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  c.started(item);
  if (approval && needsApproval('exec')) {
    const res = await ask('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId: thread.id,
      turnId: turn.id,
      itemId: id,
      startedAtMs: Date.now(),
      environmentId: null,
      reason: 'This command needs to run outside the read-only sandbox',
      command: item.command,
      cwd: thread.cwd,
      commandActions: item.commandActions,
    });
    if (res.cancelled) throw new Interrupted();
    if (res.decision === 'acceptForSession') sessionGrants.add('exec');
    if (res.decision !== 'accept' && res.decision !== 'acceptForSession') {
      c.completed({ ...item, status: 'declined' });
      return false;
    }
  }
  let agg = '';
  for (const chunk of output.match(/[^\n]*\n?/g)?.filter(Boolean) ?? []) {
    c.check();
    await sleep(80);
    agg += chunk;
    notify('item/commandExecution/outputDelta', {
      threadId: thread.id,
      turnId: turn.id,
      itemId: id,
      delta: chunk,
    });
  }
  c.completed({
    ...item,
    status: exitCode === 0 ? 'completed' : 'failed',
    aggregatedOutput: agg,
    exitCode,
    durationMs: 420,
  });
  return true;
}

const scenarios = [];
const scenario = (re, fn) => scenarios.push({ re, fn });

// The process stops reading stdin after this turn but keeps running (a wedged app-server).
let closeInputAfterTurn = false;
scenario(/close (?:your )?input/i, async (c) => {
  await c.message('Closing my input now.');
  closeInputAfterTurn = true;
});

// An approval request that arrives after the turn completed.
let lateAskAfterTurn = false;
let lateDecision = 'none';
scenario(/late ask/i, async (c) => {
  await c.message("I'll fetch in the background.");
  lateAskAfterTurn = true;
});
scenario(/background decision/i, async (c) => {
  await c.message(`Background request: ${lateDecision}`);
});

function lateAsk(turn) {
  const id = nextServerId++;
  send({
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: thread.id,
      turnId: turn.id,
      itemId: `call_${randomUUID()}`,
      command: 'git fetch',
      cwd: thread.cwd,
      reason: 'Fetch in the background',
    },
  });
  serverWaiters.set(id, (res) => {
    lateDecision = typeof res.decision === 'string' ? res.decision : JSON.stringify(res);
  });
}

scenario(/crash/i, async (c) => {
  await c.message('Starting, this will go badly');
  process.stderr.write('fake-codex: simulated crash\n');
  process.exit(3);
});

scenario(/hello/i, async (c) => {
  await c.message(
    "Hello! I'm a **fake Codex** used by the phone-code test suite.\n\n- I stream markdown\n- I run commands with approval\n- I edit files with `apply_patch`",
  );
});

scenario(/think/i, async (c) => {
  await c.reasoning('**Considering the question** I should weigh the options before answering.');
  await c.message('The answer is **42**.');
});

scenario(/run tests?/i, async (c, turn) => {
  await c.message("I'll run the tests.");
  const ok = await command(c, turn, 'npm test', {
    output: '> fake@1.0.0 test\n> node --test\n\n✔ adds numbers\n✔ parses config\nℹ pass 2\nℹ fail 0\n',
  });
  await c.message(ok ? 'Both tests passed.' : "OK, I won't run the tests.");
});

scenario(/failing/i, async (c, turn) => {
  await command(c, turn, 'ls ./does-not-exist', {
    output: "ls: cannot access './does-not-exist': No such file or directory\n",
    exitCode: 2,
    approval: false,
  });
  await c.message('That directory does not exist.');
});

scenario(/edit file/i, async (c, turn) => {
  const file = path.join(thread.cwd, 'notes.md');
  let original = null;
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch {
    // add
  }
  const next =
    original === null
      ? '# Notes\n\nhello world\n'
      : original.replace(/hello world/, 'hello from codex') === original
        ? `${original}edited by codex\n`
        : original.replace(/hello world/, 'hello from codex');
  const diff = original === null ? next : unified(original, next);
  const id = `call_${randomUUID()}`;
  const changes = [
    { path: file, kind: original === null ? { type: 'add' } : { type: 'update', move_path: null }, diff },
  ];
  const item = { type: 'fileChange', id, changes, status: 'inProgress' };
  await c.message(original === null ? "I'll create `notes.md`." : "I'll update `notes.md`.");
  c.started(item);
  if (needsApproval('edit')) {
    const res = await ask('item/fileChange/requestApproval', {
      threadId: thread.id,
      turnId: turn.id,
      itemId: id,
      startedAtMs: Date.now(),
      reason: null,
      grantRoot: null,
    });
    if (res.cancelled) throw new Interrupted();
    if (res.decision === 'acceptForSession') sessionGrants.add('edit');
    if (res.decision !== 'accept' && res.decision !== 'acceptForSession') {
      c.completed({ ...item, status: 'declined' });
      await c.message('Left the file alone.');
      return;
    }
  }
  fs.writeFileSync(file, next);
  c.completed({ ...item, status: 'completed' });
  notify('turn/diff/updated', { threadId: thread.id, turnId: turn.id, diff });
  await c.message('Done.');
});

function unified(a, b) {
  // Minimal single-hunk diff (whole file as context) for the fake.
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.at(-1) === '') A.pop();
  if (B.at(-1) === '') B.pop();
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      lines.push(` ${A[i]}`);
      i++;
      j++;
    } else {
      if (i < A.length) lines.push(`-${A[i++]}`);
      if (j < B.length) lines.push(`+${B[j++]}`);
    }
  }
  return `@@ -1,${A.length} +1,${B.length} @@\n${lines.join('\n')}\n`;
}

scenario(/ask me/i, async (c, turn) => {
  const res = await ask('item/tool/requestUserInput', {
    threadId: thread.id,
    turnId: turn.id,
    itemId: `call_${randomUUID()}`,
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: 'pm',
        header: 'Tooling',
        question: 'Which package manager should I use?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'bun', description: 'Fast' },
          { label: 'npm', description: 'Default' },
        ],
      },
    ],
  });
  if (res.cancelled) throw new Interrupted();
  const choice = res.answers?.pm?.answers?.[0] ?? 'nothing';
  await c.message(`Great, I'll use **${choice}**.`);
});

scenario(/todo|plan/i, async (c, turn) => {
  const steps = ['Read the code', 'Write the fix', 'Run the tests'];
  for (let s = 0; s <= steps.length; s++) {
    c.check();
    notify('turn/plan/updated', {
      threadId: thread.id,
      turnId: turn.id,
      explanation: s === 0 ? 'Three steps' : null,
      plan: steps.map((step, i) => ({
        step,
        status: i < s ? 'completed' : i === s ? 'inProgress' : 'pending',
      })),
    });
    await sleep(400);
  }
  await c.message('All steps done.');
});

scenario(/search/i, async (c) => {
  const id = `ws_${randomUUID()}`;
  c.started({ type: 'webSearch', id, query: '', action: null, results: null });
  await sleep(300);
  c.completed({
    type: 'webSearch',
    id,
    query: 'bun spawn detached',
    action: { type: 'search', query: 'bun spawn detached', queries: null },
    results: null,
  });
  const mid = `mcp_${randomUUID()}`;
  const mcp = {
    type: 'mcpToolCall',
    id: mid,
    server: 'docs',
    environmentId: null,
    tool: 'lookup',
    status: 'inProgress',
    arguments: { q: 'spawn' },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: true,
    result: null,
    error: null,
    durationMs: null,
  };
  c.started(mcp);
  await sleep(200);
  c.completed({
    ...mcp,
    status: 'completed',
    result: {
      content: [{ type: 'text', text: 'Bun.spawn supports detached via node:child_process' }],
      structuredContent: null,
      _meta: null,
    },
    durationMs: 200,
  });
  await c.message('Found it.');
});

scenario(/long/i, async (c) => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
  await c.message(`Here is a long answer: ${words.join(' ')}.`, 100);
});

scenario(/./s, async (c, _turn, text) => {
  await c.message(`You said: ${text.slice(0, 200)}`);
});

async function runTurn(turn, input) {
  const text = input
    .filter((i) => i.type === 'text')
    .map((i) => i.text)
    .join('\n');
  current = { turn, aborted: false, onAbort: new Set() };
  turn.startedAt = nowS();
  const started = Date.now();
  if (!thread.preview) thread.preview = text;
  appendRollout({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  notify('thread/status/changed', { threadId: thread.id, status: { type: 'active', activeFlags: [] } });
  notify('turn/started', { threadId: thread.id, turn: { ...turn, startedAt: turn.startedAt } });
  const c = ctx(turn);
  const userItem = { type: 'userMessage', id: randomUUID(), clientId: null, content: input };
  c.started(userItem);
  c.completed(userItem);
  const sc = scenarios.find((s) => s.re.test(text));
  try {
    await sc.fn(c, turn, text);
    turn.status = 'completed';
  } catch (e) {
    if (!(e instanceof Interrupted)) {
      turn.status = 'failed';
      turn.error = { message: String(e), codexErrorInfo: null, additionalDetails: null, misalignment: null };
    } else turn.status = 'interrupted';
  }
  c.usage(1500, 120);
  turn.completedAt = nowS();
  turn.durationMs = Date.now() - started;
  appendRollout({ type: 'phonecode_fake_turn', payload: turn });
  thread.turns.push(turn);
  current = null;
  notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } });
  notify('turn/completed', { threadId: thread.id, turn: { ...turn, items: [], itemsView: 'notLoaded' } });
  if (lateAskAfterTurn) {
    lateAskAfterTurn = false;
    await sleep(300);
    lateAsk(turn);
  }
  if (closeInputAfterTurn) {
    closeInputAfterTurn = false;
    process.stdin.removeAllListeners('end');
    process.stdin.destroy();
    try {
      fs.closeSync(0); // the host's next write fails with EPIPE
    } catch {
      // already closed
    }
    setInterval(() => {}, 60_000); // keep running without input
  }
}
