#!/usr/bin/env bun
// Scripted stand-in for an Agent Client Protocol (ACP v1) agent such as
// `gemini --acp` or `opencode acp` (see README.md): JSON-RPC 2.0 over stdio,
// one object per line, with "jsonrpc":"2.0". Shapes follow the stable v1
// schema of @agentclientprotocol/sdk 2.8.0; modes/models are shaped like
// Gemini CLI 0.70.0's (legacy `modes`) and OpenCode 1.19.6's (`configOptions`).
// Dependency-free; bun or node.
/* oxlint-disable no-await-in-loop, consistent-return -- a scripted agent streams sequentially; handlers return their reply */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('fake-acp 1.0.0\n');
  process.exit(0);
}

const speed = Number(process.env.FAKE_SPEED ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));
const home = process.env.FAKE_ACP_HOME || path.join(os.tmpdir(), 'fake-acp-home');
const requireAuth = process.env.FAKE_ACP_REQUIRE_AUTH === '1';
// Started as `agy acp` (the Antigravity preset): an agent with no mode that approves everything.
const MODES = [
  { id: 'default', name: 'Default', description: 'Prompts for approval' },
  ...(argv[0] === 'acp'
    ? []
    : [
        { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
        { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
      ]),
  { id: 'plan', name: 'Plan', description: 'Read-only mode' },
];
const MODELS = ['fake-pro', 'fake-flash'];

// ---------------------------------------------------------------- output
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const result = (id, res) => send({ id, result: res });
const rpcError = (id, code, message, data) =>
  send({ id, error: { code, message, ...(data ? { data } : {}) } });
let nextServerId = 1;
const serverWaiters = new Map();
function request(method, params) {
  const id = `srv-${nextServerId++}`;
  send({ id, method, params });
  return new Promise((resolve) => serverWaiters.set(id, resolve));
}

// ---------------------------------------------------------------- state
let clientCaps = {};
let authenticated = !requireAuth;
/** @type {Map<string, {id: string, cwd: string, mode: string, model: string, title: string, history: any[], updatedAt: string}>} */
const sessions = new Map();
let current = null; // { sessionId, aborted, onAbort: Set<fn> }
const alwaysAllowed = new Set();

const file = (id) => path.join(home, 'sessions', `${id}.json`);
function save(s) {
  try {
    fs.mkdirSync(path.dirname(file(s.id)), { recursive: true });
    fs.writeFileSync(file(s.id), JSON.stringify(s));
  } catch {
    // ignore
  }
}
function loadStored(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return undefined;
  }
}
function listStored() {
  let names = [];
  try {
    names = fs.readdirSync(path.join(home, 'sessions'));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => loadStored(n.slice(0, -5)))
    .filter(Boolean);
}

function configOptions(s) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: MODELS.map((m) => ({ value: m, name: m })),
    },
    // Like OpenCode's "variant" / Gemini's thinking budget: the spec's thought_level category.
    {
      id: 'thought',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: s.thought ?? 'medium',
      options: THOUGHT_LEVELS.map((t) => ({ value: t.value, name: t.name })),
    },
  ];
}
const THOUGHT_LEVELS = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'deep', name: 'Deep think' },
];
const modesState = (s) => ({ availableModes: MODES, currentModeId: s.mode });

/** Send a session/update and keep it for session/load replay. */
function update(s, upd, { keep = true } = {}) {
  send({ method: 'session/update', params: { sessionId: s.id, update: upd } });
  if (keep) s.history.push(upd);
}

// ------------------------------------------------------------- scenarios
class Aborted extends Error {}

function ctx(s) {
  const turn = current;
  const check = () => {
    if (turn.aborted) throw new Aborted();
  };
  let msgN = 0;
  return {
    s,
    check,
    async say(text, kind = 'agent_message_chunk', delay = 40) {
      const messageId = randomUUID();
      msgN++;
      for (const w of text.split(/(?<= )/)) {
        check();
        update(s, { sessionUpdate: kind, messageId, content: { type: 'text', text: w } });
        await sleep(delay);
      }
    },
    tool(toolCallId, fields) {
      update(s, { sessionUpdate: 'tool_call', toolCallId, ...fields });
    },
    toolUpdate(toolCallId, fields) {
      update(s, { sessionUpdate: 'tool_call_update', toolCallId, ...fields });
    },
    /** Ask for permission. Resolves 'allow' | 'always' | 'deny' | 'cancelled'. */
    async permission(toolCall, auto) {
      if (auto) return 'allow';
      const options = [
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'proceed_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ];
      const res = await request('session/request_permission', { sessionId: s.id, toolCall, options });
      const outcome = res?.result?.outcome;
      if (!outcome || outcome.outcome === 'cancelled') return 'cancelled';
      return outcome.optionId === 'proceed_always'
        ? 'always'
        : outcome.optionId === 'proceed_once'
          ? 'allow'
          : 'deny';
    },
    get msgN() {
      return msgN;
    },
  };
}

async function runTests(c) {
  await c.say('I will run the test suite. ');
  const id = `call_${randomUUID().slice(0, 8)}`;
  const toolCall = {
    toolCallId: id,
    title: 'npm test',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'npm test', description: 'Run the tests' },
  };
  c.tool(id, toolCall);
  const auto = c.s.mode === 'yolo' || alwaysAllowed.has('execute');
  const answer = await c.permission(toolCall, auto);
  c.check();
  if (answer === 'cancelled') throw new Aborted();
  if (answer === 'deny') {
    c.toolUpdate(id, {
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'Rejected by the user' } }],
    });
    await c.say('Okay, I will not run the tests.');
    return;
  }
  if (answer === 'always') alwaysAllowed.add('execute');
  c.toolUpdate(id, { status: 'in_progress' });
  await sleep(300);
  c.check();
  const out =
    '> fake@1.0.0 test\n> node --test\n\n✔ adds numbers (1.2ms)\n✔ parses input (0.8ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n';
  c.toolUpdate(id, {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: out } }],
    rawOutput: { output: out, exitCode: 0 },
  });
  await c.say('All tests pass:\n\n| suite | passed | failed |\n| --- | --- | --- |\n| unit | 2 | 0 |\n');
}

async function failing(c) {
  const id = `call_${randomUUID().slice(0, 8)}`;
  c.tool(id, {
    title: 'ls ./does-not-exist',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'ls ./does-not-exist' },
  });
  await sleep(200);
  const out = "ls: cannot access './does-not-exist': No such file or directory\n";
  c.toolUpdate(id, {
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: out } }],
    rawOutput: { output: out, exitCode: 2 },
  });
  await c.say('That folder does not exist.');
}

async function editFile(c) {
  const target = path.join(c.s.cwd, 'notes.md');
  let oldText = null;
  if (clientCaps.fs?.readTextFile) {
    const r = await request('fs/read_text_file', { sessionId: c.s.id, path: target });
    if (r.result) oldText = r.result.content;
  } else if (fs.existsSync(target)) oldText = fs.readFileSync(target, 'utf8');
  const newText =
    oldText === null
      ? '# Notes\n\nhello world\n'
      : `${oldText.replace('hello world', 'hello phone-code')}one more line\n`;
  const id = `call_${randomUUID().slice(0, 8)}`;
  const toolCall = {
    toolCallId: id,
    title: oldText === null ? 'Write notes.md' : 'Edit notes.md',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: target }],
    content: [{ type: 'diff', path: target, oldText, newText }],
    rawInput: { file_path: target },
  };
  c.tool(id, toolCall);
  const auto = c.s.mode === 'yolo' || c.s.mode === 'autoEdit' || alwaysAllowed.has('edit');
  const answer = await c.permission(toolCall, auto);
  c.check();
  if (answer === 'cancelled') throw new Aborted();
  if (answer === 'deny') {
    c.toolUpdate(id, { status: 'failed' });
    await c.say('Okay, I left the file alone.');
    return;
  }
  if (answer === 'always') alwaysAllowed.add('edit');
  c.toolUpdate(id, { status: 'in_progress' });
  if (clientCaps.fs?.writeTextFile) {
    const w = await request('fs/write_text_file', { sessionId: c.s.id, path: target, content: newText });
    if (w.error) {
      c.toolUpdate(id, {
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: w.error.message } }],
      });
      await c.say(`The write failed: ${w.error.message}`);
      return;
    }
  } else fs.writeFileSync(target, newText);
  c.toolUpdate(id, { status: 'completed' });
  await c.say(oldText === null ? 'Created `notes.md`.' : 'Updated `notes.md`.');
}

async function readOutside(c) {
  const id = `call_${randomUUID().slice(0, 8)}`;
  c.tool(id, {
    title: 'Read /etc/hostname',
    kind: 'read',
    status: 'in_progress',
    locations: [{ path: '/etc/hostname' }],
  });
  const r = await request('fs/read_text_file', { sessionId: c.s.id, path: '/etc/hostname' });
  const text = r.error ? `Error: ${r.error.message}` : r.result.content;
  c.toolUpdate(id, {
    status: r.error ? 'failed' : 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  await c.say(r.error ? 'The client refused to read that file.' : 'Read it.');
}

async function terminal(c) {
  if (!clientCaps.terminal) {
    await c.say('This client has no terminals.');
    return;
  }
  const id = `call_${randomUUID().slice(0, 8)}`;
  const toolCall = {
    toolCallId: id,
    title: 'echo hello && ls',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'echo hello from a terminal && ls' },
  };
  c.tool(id, toolCall);
  const answer = await c.permission(toolCall, c.s.mode === 'yolo' || alwaysAllowed.has('execute'));
  c.check();
  if (answer === 'cancelled') throw new Aborted();
  if (answer === 'deny') {
    c.toolUpdate(id, { status: 'failed' });
    return;
  }
  const t = await request('terminal/create', {
    sessionId: c.s.id,
    command: 'echo hello from a terminal && sleep 0.3 && ls',
    cwd: c.s.cwd,
  });
  const terminalId = t.result.terminalId;
  c.toolUpdate(id, { status: 'in_progress', content: [{ type: 'terminal', terminalId }] });
  const exit = await request('terminal/wait_for_exit', { sessionId: c.s.id, terminalId });
  const out = await request('terminal/output', { sessionId: c.s.id, terminalId });
  await request('terminal/release', { sessionId: c.s.id, terminalId });
  c.toolUpdate(id, {
    status: exit.result.exitCode === 0 ? 'completed' : 'failed',
    rawOutput: { output: out.result.output, exitCode: exit.result.exitCode },
  });
  await c.say(`The command exited with ${exit.result.exitCode}.`);
}

async function plan(c) {
  const steps = ['Read the code', 'Make the change', 'Run the tests'];
  for (let i = 0; i <= steps.length; i++) {
    c.check();
    update(c.s, {
      sessionUpdate: 'plan',
      entries: steps.map((content, j) => ({
        content,
        priority: 'medium',
        status: j < i ? 'completed' : j === i ? 'in_progress' : 'pending',
      })),
    });
    await sleep(500);
  }
  await c.say('Done with the plan.');
}

async function search(c) {
  const a = `call_${randomUUID().slice(0, 8)}`;
  c.tool(a, {
    title: "grep 'TODO'",
    kind: 'search',
    status: 'in_progress',
    rawInput: { pattern: 'TODO', path: c.s.cwd },
  });
  await sleep(150);
  c.toolUpdate(a, {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'src/app.ts:3: // TODO' } }],
  });
  const b = `call_${randomUUID().slice(0, 8)}`;
  c.tool(b, {
    title: 'https://example.com/docs',
    kind: 'fetch',
    status: 'in_progress',
    rawInput: { url: 'https://example.com/docs' },
  });
  await sleep(150);
  c.toolUpdate(b, {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Example docs' } }],
  });
  const t = `call_${randomUUID().slice(0, 8)}`;
  c.tool(t, { title: 'Weighing options', kind: 'think', status: 'completed' });
  await c.say('Found one TODO.');
}

// The process stops reading stdin after this prompt but keeps running (a wedged agent).
let closeInputAfterTurn = false;
// A permission request that arrives after the prompt ended.
let lateAskAfterTurn = false;
let lateDecision = 'none';

async function lateAsk(s) {
  const res = await request('session/request_permission', {
    sessionId: s.id,
    toolCall: {
      toolCallId: `call_${randomUUID().slice(0, 8)}`,
      title: 'git fetch',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'git fetch' },
    },
    options: [
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const o = res?.result?.outcome;
  lateDecision = o?.outcome === 'selected' ? o.optionId : (o?.outcome ?? 'error');
}

/** Antigravity-style question: a generic tool call plus a form elicitation that names it. */
async function askMe(c) {
  if (!clientCaps.elicitation?.form) {
    await c.say('Which color should I use, blue or red?');
    return;
  }
  const id = `call_${randomUUID().slice(0, 8)}`;
  c.tool(id, { title: 'Run ask_question', kind: 'other', status: 'in_progress', rawInput: {} });
  const answer = await request('elicitation/create', {
    sessionId: c.s.id,
    toolCallId: id,
    mode: 'form',
    message: 'The agent has a question.',
    requestedSchema: {
      type: 'object',
      properties: {
        q1: {
          type: 'string',
          title: 'Which color?',
          oneOf: [
            { const: '1', title: '(Recommended) Blue' },
            { const: '2', title: 'Red' },
          ],
        },
        q1_other: {
          type: 'string',
          title: 'Other',
          description: 'Optional free-form answer to: Which color?',
        },
        q2: {
          type: 'array',
          title: 'Which platforms?',
          items: {
            anyOf: [
              { const: 'ios', title: 'iOS' },
              { const: 'android', title: 'Android' },
              { const: 'web', title: 'Web' },
            ],
          },
        },
        q3: {
          type: 'string',
          title: 'Which license?',
          oneOf: [
            { const: 'mit', title: 'MIT' },
            { const: 'apache', title: 'Apache-2.0' },
          ],
        },
        q3_other: {
          type: 'string',
          title: 'Other',
          description: 'Optional free-form answer to: Which license?',
        },
      },
    },
  });
  const r = answer.result ?? {};
  c.toolUpdate(id, {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(r) } }],
  });
  if (r.action !== 'accept') {
    await c.say(`No answer (${r.action ?? 'error'}).`);
    return;
  }
  await c.say(`Received: ${JSON.stringify(r.content)}`);
}

const COMMANDS = [
  { name: 'init', description: 'Create AGENTS.md' },
  { name: 'help', description: 'List the commands', input: null },
  { name: 'review', description: 'Review the changes', input: { hint: 'what to focus on' } },
];

const SCENARIOS = [
  [
    /^\/help\b/,
    async (c) => {
      await c.say(`Commands: ${COMMANDS.map((x) => `/${x.name}`).join(', ')}`);
    },
  ],
  [
    /close (?:your )?input/i,
    async (c) => {
      await c.say('Closing my input now.');
      closeInputAfterTurn = true;
    },
  ],
  [
    /late ask/i,
    async (c) => {
      await c.say("I'll fetch in the background.");
      lateAskAfterTurn = true;
    },
  ],
  [/background decision/i, (c) => c.say(`Background request: ${lateDecision}`)],
  // How Antigravity reports a failed model call: as an ordinary reply that ends the turn.
  [/model error/i, (c) => c.say('⚠ agent executor error: model unavailable (RESOURCE_EXHAUSTED)')],
  [/ask me/i, askMe],
  [
    /crash/i,
    async (c) => {
      await c.say('Starting to work on it ');
      process.stderr.write('fake-acp: simulated crash\n');
      process.exit(3);
    },
  ],
  [/thinking level/i, (c) => c.say(`Thinking level: **${c.s.thought ?? 'medium'}**.`)],
  [/hello/i, (c) => c.say('Hello! I am a **fake ACP agent**.\n\n- I stream text\n- I run tools\n')],
  [
    /think/i,
    async (c) => {
      await c.say('Let me think about this carefully. ', 'agent_thought_chunk');
      await c.say('The answer is 42.');
    },
  ],
  [/run tests/i, runTests],
  [/failing/i, failing],
  [/edit file/i, editFile],
  [/read outside/i, readOutside],
  [/terminal/i, terminal],
  [/todo|plan/i, plan],
  [/search/i, search],
  [
    /notice/i,
    async (c) => {
      if (clientCaps.session?.notices)
        update(
          c.s,
          {
            sessionUpdate: 'notice',
            severity: 'warning',
            title: 'Rate limited',
            description: 'Retrying in 1s',
          },
          { keep: false },
        );
      await c.say('Sent a notice.');
    },
  ],
  [
    /long/i,
    async (c) => {
      const words = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
      await c.say(`Here is a long answer: ${words.join(' ')}.`, 'agent_message_chunk', 100);
    },
  ],
];

async function prompt(id, params) {
  const s = sessions.get(params.sessionId);
  if (!s) return rpcError(id, -32002, 'Session not found');
  if (current) return rpcError(id, -32600, 'A prompt is already running');
  const text = (params.prompt ?? [])
    .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? (b.resource?.text ?? '') : ''))
    .join('');
  s.history.push({
    sessionUpdate: 'user_message_chunk',
    messageId: randomUUID(),
    content: { type: 'text', text },
  });
  if (s.title === '') s.title = text.slice(0, 60);
  current = { sessionId: s.id, aborted: false };
  const c = ctx(s);
  let stopReason = 'end_turn';
  try {
    const found = SCENARIOS.find(([re]) => re.test(text));
    if (found) await found[1](c);
    else {
      const images = (params.prompt ?? []).filter((b) => b.type === 'image').map((b) => b.mimeType);
      await c.say(
        `You said: ${text}${images.length ? ` [with ${images.length} image(s): ${images.join(', ')}]` : ''}`,
      );
    }
    if (current.aborted) stopReason = 'cancelled';
  } catch (e) {
    if (e instanceof Aborted) stopReason = 'cancelled';
    else {
      current = null;
      return rpcError(id, -32603, `Internal error: ${e?.message ?? e}`);
    }
  }
  current = null;
  s.updatedAt = new Date().toISOString();
  save(s);
  result(id, { stopReason, usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } });
  update(
    s,
    {
      sessionUpdate: 'usage_update',
      used: 1000,
      size: 100000,
      cost: { amount: 0.01 * s.history.length, currency: 'USD' },
    },
    { keep: false },
  );
  if (lateAskAfterTurn) {
    lateAskAfterTurn = false;
    await sleep(300);
    void lateAsk(s);
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
  return undefined;
}

function sessionState(s) {
  return { modes: modesState(s), configOptions: configOptions(s) };
}

async function onMessage(msg) {
  if (msg.id !== undefined && !msg.method) {
    const w = serverWaiters.get(msg.id);
    if (w) {
      serverWaiters.delete(msg.id);
      w(msg);
    }
    return;
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      clientCaps = params.clientCapabilities ?? {};
      return result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [
          { id: 'fake-login', name: 'Log in with Fake', description: 'Run `fake-acp login` in a terminal' },
          {
            id: 'fake-api-key',
            name: 'Fake API key',
            description: 'Use the FAKE_ACP_API_KEY environment variable',
          },
          { id: 'fake-terminal', name: 'Terminal login', type: 'terminal', args: ['login'] },
        ],
        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' },
      });
    case 'authenticate':
      if (params.methodId === 'fake-api-key' && process.env.FAKE_ACP_API_KEY) authenticated = true;
      return authenticated ? result(id, {}) : rpcError(id, -32000, 'Authentication required');
    case 'session/new': {
      if (!authenticated) return rpcError(id, -32000, 'Authentication required: run `fake-acp login`');
      const s = {
        id: `fake_${randomUUID()}`,
        cwd: params.cwd,
        mode: 'default',
        model: MODELS[0],
        title: '',
        history: [],
        updatedAt: new Date().toISOString(),
      };
      sessions.set(s.id, s);
      save(s);
      result(id, { sessionId: s.id, ...sessionState(s) });
      update(
        s,
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: COMMANDS,
        },
        { keep: false },
      );
      return undefined;
    }
    case 'session/load':
    case 'session/resume': {
      if (!authenticated) return rpcError(id, -32000, 'Authentication required');
      const stored = sessions.get(params.sessionId) ?? loadStored(params.sessionId);
      if (!stored) return rpcError(id, -32002, `Session ${params.sessionId} not found`);
      stored.cwd = params.cwd ?? stored.cwd;
      sessions.set(stored.id, stored);
      if (method === 'session/load') {
        for (const upd of stored.history) {
          send({ method: 'session/update', params: { sessionId: stored.id, update: upd } });
          await sleep(2);
        }
      }
      result(id, sessionState(stored));
      update(
        stored,
        { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS },
        { keep: false },
      );
      return undefined;
    }
    case 'session/list':
      return result(id, {
        sessions: listStored()
          .filter((s) => !params.cwd || s.cwd === params.cwd)
          .map((s) => ({
            sessionId: s.id,
            cwd: s.cwd,
            title: s.title || 'New session',
            updatedAt: s.updatedAt,
          })),
      });
    case 'session/close':
      sessions.delete(params.sessionId);
      return result(id, {});
    case 'session/set_mode': {
      const s = sessions.get(params.sessionId);
      if (!s || !MODES.some((m) => m.id === params.modeId)) return rpcError(id, -32602, 'Invalid mode');
      s.mode = params.modeId;
      result(id, {});
      update(s, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }, { keep: false });
      return undefined;
    }
    case 'session/set_config_option':
    case 'session/set_model': {
      const s = sessions.get(params.sessionId);
      const value = method === 'session/set_model' ? params.modelId : params.value;
      if (s && method === 'session/set_config_option' && params.configId === 'thought') {
        if (!THOUGHT_LEVELS.some((t) => t.value === value))
          return rpcError(id, -32602, 'Invalid thought level');
        s.thought = value;
        return result(id, { configOptions: configOptions(s) });
      }
      if (
        !s ||
        (method === 'session/set_config_option' && params.configId !== 'model') ||
        !MODELS.includes(value)
      )
        return rpcError(id, -32602, 'Invalid config option');
      s.model = value;
      return result(id, method === 'session/set_model' ? {} : { configOptions: configOptions(s) });
    }
    case 'session/prompt':
      return prompt(id, params);
    case 'session/cancel':
      if (current && current.sessionId === params.sessionId) current.aborted = true;
      return undefined;
    default:
      if (id !== undefined) return rpcError(id, -32601, `Method not found: ${method}`);
      return undefined; // unknown notification
  }
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
    void onMessage(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(143));
