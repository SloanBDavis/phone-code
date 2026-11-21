#!/usr/bin/env bun
// Scripted stand-in for the `claude` CLI in stream-json mode (see README.md).
// Speaks the same stdio protocol phone-code's adapter (and the Agent SDK) use:
//   claude --output-format stream-json --verbose --input-format stream-json
//          --include-partial-messages --permission-prompt-tool stdio
//          [--model m] [--permission-mode m] [--session-id id | --resume id]
// Framing and field names are copied from a capture of Claude Code 2.1.330.
// Dependency-free; runs under bun or node.
/* oxlint-disable no-await-in-loop -- a scripted agent streams and runs turns sequentially on purpose */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('2.1.330 (Claude Code)\n');
  process.exit(0);
}
const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-fake',
  opus: 'claude-opus-fake',
  haiku: 'claude-haiku-fake',
  default: 'claude-sonnet-fake',
};
const resolveModel = (m) => MODEL_ALIASES[m] ?? m ?? 'claude-sonnet-fake';
let model = resolveModel(arg('--model'));
let mode = arg('--permission-mode') ?? 'default';
const resumeId = arg('--resume');
const sessionId = resumeId ?? arg('--session-id') ?? randomUUID();
const cwd = process.cwd();
const speed = Number(process.env.FAKE_SPEED ?? 1); // >1 = faster
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));

// ------------------------------------------------------------ transcript
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectDir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
let lastUuid = null;
let transcript = [];
if (resumeId) {
  try {
    transcript = fs
      .readFileSync(sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    for (const e of transcript) if (e.uuid) lastUuid = e.uuid;
  } catch {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      usage: usage(0, 0),
      modelUsage: {},
      permission_denials: [],
      errors: [`No conversation found with session ID: ${resumeId}`],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    process.exit(1);
  }
}
function persist(entry) {
  const full = {
    parentUuid: lastUuid,
    isSidechain: false,
    ...entry,
    cwd,
    sessionId,
    version: '2.1.330',
    timestamp: new Date().toISOString(),
  };
  if (full.uuid) lastUuid = full.uuid;
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.appendFileSync(sessionFile, `${JSON.stringify(full)}\n`);
  } catch {
    // read-only home: keep going
  }
}

// ---------------------------------------------------------------- output
function out(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
const usage = (input, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
  service_tier: 'standard',
});
let totalCost = 0;
const allowRules = []; // from allowAlways (addRules suggestions)

// ----------------------------------------------------------------- input
let buf = '';
const queue = [];
let wake = null;
const controlWaiters = new Map();
let current = null; // { aborted, onAbort: Set<fn> }

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
process.stdin.on('end', () => {
  // Like the real CLI: finish what is running, then exit.
  queue.push({ eof: true });
  wake?.();
});
process.on('SIGTERM', () => process.exit(143));

function onMessage(msg) {
  if (msg.type === 'control_request') return onControl(msg);
  if (msg.type === 'control_response') {
    const w = controlWaiters.get(msg.response?.request_id);
    if (w) {
      controlWaiters.delete(msg.response.request_id);
      w(msg.response);
    }
    return;
  }
  if (msg.type === 'user') {
    queue.push(msg);
    wake?.();
  }
}

function respond(requestId, response) {
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

function onControl(msg) {
  const req = msg.request ?? {};
  switch (req.subtype) {
    case 'initialize':
      return respond(msg.request_id, {
        commands: [
          {
            name: 'compact',
            description: 'Clear conversation history but keep a summary in context',
            argumentHint: '',
          },
        ],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: [
          {
            value: 'default',
            resolvedModel: 'claude-sonnet-fake',
            displayName: 'Default (recommended)',
            description: 'Fake Sonnet',
          },
          { value: 'opus', resolvedModel: 'claude-opus-fake', displayName: 'Opus', description: 'Fake Opus' },
          {
            value: 'sonnet',
            resolvedModel: 'claude-sonnet-fake',
            displayName: 'Sonnet',
            description: 'Fake Sonnet',
          },
          {
            value: 'haiku',
            resolvedModel: 'claude-haiku-fake',
            displayName: 'Haiku',
            description: 'Fake Haiku',
          },
        ],
        account: { subscriptionType: 'fake' },
        pid: process.pid,
        claude_code_version: '2.1.330',
        current_permission_mode: mode,
        session_state: 'idle',
        capabilities: [],
      });
    case 'set_permission_mode':
      mode = req.mode;
      respond(msg.request_id, { mode });
      return out({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: mode,
        uuid: randomUUID(),
        session_id: sessionId,
      });
    case 'set_model':
      model = resolveModel(req.model);
      out({
        type: 'user',
        message: {
          role: 'user',
          content: `<local-command-stdout>Set model to \`${model}\`</local-command-stdout>`,
        },
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        isReplay: true,
      });
      return respond(msg.request_id, { model });
    case 'interrupt':
      respond(msg.request_id, { still_queued: [] });
      if (current && !current.aborted) {
        current.aborted = true;
        for (const fn of current.onAbort) fn();
      }
      return;
    default:
      return out({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: msg.request_id,
          error: `Unsupported control request subtype: ${req.subtype}`,
        },
      });
  }
}

/** Ask the host. Resolves with the host's response, or {behavior:'cancelled'} on interrupt. */
function canUseTool(toolName, input, toolUseId, suggestions = []) {
  const requestId = randomUUID();
  out({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'requires_action',
    sdk_host_only: true,
    uuid: randomUUID(),
    session_id: sessionId,
  });
  out({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: toolName,
      display_name: toolName,
      input,
      description: input.description ?? '',
      permission_suggestions: suggestions,
      tool_use_id: toolUseId,
    },
  });
  return new Promise((resolve) => {
    const cancel = () => {
      controlWaiters.delete(requestId);
      out({ type: 'control_cancel_request', request_id: requestId });
      resolve({ behavior: 'cancelled' });
    };
    current.onAbort.add(cancel);
    controlWaiters.set(requestId, (resp) => {
      current.onAbort.delete(cancel);
      out({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
        sdk_host_only: true,
        uuid: randomUUID(),
        session_id: sessionId,
      });
      const r = resp.response ?? {};
      if (r.behavior === 'allow') {
        for (const u of r.updatedPermissions ?? []) {
          if (u.type === 'addRules')
            allowRules.push(...u.rules.map((x) => `${x.toolName}(${x.ruleContent ?? '*'})`));
          if (u.type === 'setMode') {
            mode = u.mode;
            out({
              type: 'system',
              subtype: 'status',
              status: null,
              permissionMode: mode,
              uuid: randomUUID(),
              session_id: sessionId,
            });
          }
        }
      }
      resolve(r);
    });
  });
}

function needsPermission(toolName, input) {
  if (mode === 'bypassPermissions') return false;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    if (mode === 'acceptEdits') return false;
    return !allowRules.includes(`${toolName}(*)`) && !allowRules.includes('Edit(*)');
  }
  if (toolName === 'Bash') return !allowRules.includes(`Bash(${input.command})`);
  return false;
}

// ---------------------------------------------------------------- turns
class Interrupted extends Error {}

function makeTurn() {
  const msgId = `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  let index = 0;
  const t = {
    msgId,
    parent: /** @type {string | null} */ (null),
    check() {
      if (current.aborted) throw new Interrupted();
    },
    stream(event) {
      out({
        type: 'stream_event',
        event,
        session_id: sessionId,
        parent_tool_use_id: t.parent,
        uuid: randomUUID(),
      });
    },
    assistant(block, stop = null) {
      const entry = {
        type: 'assistant',
        message: {
          model,
          id: t.msgId,
          type: 'message',
          role: 'assistant',
          content: [block],
          stop_reason: stop,
          stop_sequence: null,
          usage: usage(12, 8),
        },
        parent_tool_use_id: t.parent,
        session_id: sessionId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      out(entry);
      persist({
        type: 'assistant',
        message: entry.message,
        uuid: entry.uuid,
        ...(t.parent ? { isSidechain: false, parentToolUseID: t.parent } : {}),
      });
    },
    newMessage() {
      t.msgId = `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      index = 0;
      out({
        type: 'system',
        subtype: 'status',
        status: 'requesting',
        session_id: sessionId,
        uuid: randomUUID(),
      });
      t.stream({
        type: 'message_start',
        message: {
          model,
          id: t.msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(12, 1),
        },
      });
    },
    endMessage(stop) {
      t.stream({
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: usage(12, 40),
      });
      t.stream({ type: 'message_stop' });
    },
    /** Stream a text (or thinking) block word by word. */
    async text(text, { kind = 'text', delay = 30 } = {}) {
      const i = index++;
      t.stream({
        type: 'content_block_start',
        index: i,
        content_block:
          kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' },
      });
      const words = text.match(/\S+\s*|\s+/g) ?? [];
      let sent = '';
      try {
        for (const w of words) {
          t.check();
          await sleep(delay);
          t.check();
          sent += w;
          t.stream({
            type: 'content_block_delta',
            index: i,
            delta:
              kind === 'text' ? { type: 'text_delta', text: w } : { type: 'thinking_delta', thinking: w },
          });
        }
      } finally {
        if (sent)
          t.assistant(
            kind === 'text'
              ? { type: 'text', text: sent }
              : { type: 'thinking', thinking: sent, signature: 'fake' },
          );
        t.stream({ type: 'content_block_stop', index: i });
      }
    },
    /** Emit a tool_use block (streamed input). Returns the tool_use id. */
    async toolUse(name, input) {
      const i = index++;
      const id = `toolu_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      t.stream({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id, name, input: {} },
      });
      const json = JSON.stringify(input);
      for (let k = 0; k < json.length; k += 24)
        t.stream({
          type: 'content_block_delta',
          index: i,
          delta: { type: 'input_json_delta', partial_json: json.slice(k, k + 24) },
        });
      t.assistant({ type: 'tool_use', id, name, input });
      t.stream({ type: 'content_block_stop', index: i });
      await sleep(20);
      return id;
    },
    toolResult(toolUseId, content, { isError = false, structured, decision } = {}) {
      const entry = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }],
        },
        parent_tool_use_id: t.parent,
        session_id: sessionId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        tool_use_result: structured ?? content,
        ...(decision ? { tool_result_meta: [{ id: toolUseId, permission_decision: { decision } }] } : {}),
      };
      out(entry);
      persist({
        type: 'user',
        message: entry.message,
        uuid: entry.uuid,
        toolUseResult: entry.tool_use_result,
        ...(decision ? { permissionDecision: { decision } } : {}),
      });
    },
  };
  return t;
}

/** Run a tool through the permission flow. Returns {ok, denied, message}. */
async function gate(t, name, input, toolUseId, suggestions) {
  if (!needsPermission(name, input)) return { ok: true };
  const r = await canUseTool(name, input, toolUseId, suggestions);
  if (r.behavior === 'cancelled') throw new Interrupted();
  if (r.behavior !== 'allow') {
    const msg = r.message || "The user doesn't want to proceed with this tool use.";
    t.toolResult(toolUseId, msg, { isError: true, structured: `Error: ${msg}`, decision: 'reject' });
    return { ok: false, denied: true, message: msg };
  }
  return { ok: true, input: r.updatedInput ?? input };
}

const scenarios = [];
const scenario = (re, fn) => scenarios.push({ re, fn });

scenario(/crash/i, async (t) => {
  t.newMessage();
  await t.text('Starting the work, this will go badly');
  process.stderr.write('fake-claude: simulated crash\n');
  process.exit(3);
});

scenario(/hello/i, async (t) => {
  t.newMessage();
  await t.text(
    "Hello! I'm a **fake Claude** used by the phone-code test suite.\n\nI can:\n\n- stream markdown like this\n- run `tests` with permission\n- edit files\n\nWhat should we build?",
  );
  t.endMessage('end_turn');
  return 'Hello!';
});

scenario(/think/i, async (t) => {
  t.newMessage();
  await t.text('The user wants me to think first. Let me consider the options carefully.', {
    kind: 'thinking',
    delay: 15,
  });
  await t.text('I thought about it: the answer is **42**.');
  t.endMessage('end_turn');
  return 'the answer is 42';
});

scenario(/run tests?/i, async (t) => {
  t.newMessage();
  await t.text("I'll run the test suite.");
  const input = { command: 'npm test', description: 'Run the test suite' };
  const id = await t.toolUse('Bash', input);
  const g = await gate(t, 'Bash', input, id, [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]);
  t.endMessage('tool_use');
  t.newMessage();
  if (!g.ok) {
    await t.text("Understood, I won't run the tests. Let me know if you want me to try something else.");
    t.endMessage('end_turn');
    return 'not run';
  }
  await sleep(400);
  t.check();
  const stdout =
    '> fake-project@1.0.0 test\n> node --test\n\n✔ adds numbers (0.4ms)\n✔ parses config (1.1ms)\n✔ renders diff (2.3ms)\nℹ tests 3\nℹ pass 3\nℹ fail 0';
  t.toolResult(id, stdout, {
    structured: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  });
  await t.text(
    'All **3 tests passed**:\n\n| test | time |\n| --- | --- |\n| adds numbers | 0.4ms |\n| parses config | 1.1ms |\n| renders diff | 2.3ms |',
  );
  t.endMessage('end_turn');
  return 'All 3 tests passed';
});

scenario(/failing/i, async (t) => {
  t.newMessage();
  const input = { command: 'ls ./does-not-exist', description: 'List a missing directory' };
  const id = await t.toolUse('Bash', input);
  t.endMessage('tool_use');
  t.newMessage();
  const err = "Exit code 2\nls: cannot access './does-not-exist': No such file or directory";
  t.toolResult(id, err, { isError: true, structured: `Error: ${err}` });
  await t.text('The directory does not exist (exit code 2).');
  t.endMessage('end_turn');
  return 'exit 2';
});

scenario(/edit file/i, async (t) => {
  const file = path.join(cwd, 'notes.md');
  let original = null;
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch {
    // create
  }
  t.newMessage();
  if (original === null) {
    await t.text("`notes.md` doesn't exist yet, so I'll create it.");
    const content = '# Notes\n\nhello world\n\n- first item\n';
    const input = { file_path: file, content };
    const id = await t.toolUse('Write', input);
    const g = await gate(t, 'Write', input, id, [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    t.endMessage('tool_use');
    t.newMessage();
    if (!g.ok) {
      await t.text('OK, I left the file alone.');
      t.endMessage('end_turn');
      return 'not written';
    }
    fs.writeFileSync(file, content);
    t.toolResult(id, `File created successfully at: ${file}`, {
      structured: { type: 'create', filePath: file, content, structuredPatch: [], originalFile: null },
    });
    await t.text('Created `notes.md`.');
    t.endMessage('end_turn');
    return 'created';
  }
  await t.text("I'll update the greeting in `notes.md`.");
  const oldString = original.includes('hello world')
    ? 'hello world'
    : (original.split('\n').find((l) => l.trim()) ?? original);
  const newString =
    oldString === 'hello world' ? 'hello phone-code\nedited by the fake agent' : `${oldString} (edited)`;
  const input = { file_path: file, old_string: oldString, new_string: newString, replace_all: false };
  const id = await t.toolUse('Edit', input);
  const g = await gate(t, 'Edit', input, id, [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
  t.endMessage('tool_use');
  t.newMessage();
  if (!g.ok) {
    await t.text('OK, I left the file alone.');
    t.endMessage('end_turn');
    return 'not edited';
  }
  const updated = original.replace(oldString, newString);
  fs.writeFileSync(file, updated);
  t.toolResult(id, `The file ${file} has been updated successfully.`, {
    structured: {
      filePath: file,
      oldString,
      newString,
      originalFile: original,
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    },
  });
  await t.text('Done: the greeting in `notes.md` now says **hello phone-code**.');
  t.endMessage('end_turn');
  return 'edited';
});

scenario(/ask me/i, async (t) => {
  t.newMessage();
  const questions = [
    {
      question: 'Which package manager should I use?',
      header: 'Tooling',
      multiSelect: false,
      options: [
        { label: 'bun', description: 'Fast, all-in-one' },
        { label: 'npm', description: 'The default' },
      ],
    },
  ];
  const input = { questions };
  const id = await t.toolUse('AskUserQuestion', input);
  const r = await canUseTool('AskUserQuestion', input, id);
  if (r.behavior === 'cancelled') throw new Interrupted();
  t.endMessage('tool_use');
  t.newMessage();
  const answers = r.updatedInput?.answers ?? {};
  const pairs = Object.entries(answers)
    .map(([q, a]) => `"${q}"="${a}"`)
    .join(', ');
  t.toolResult(
    id,
    `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`,
    { structured: { questions, answers } },
  );
  const choice = Object.values(answers)[0] ?? 'nothing';
  await t.text(`Great, I'll use **${choice}**.`);
  t.endMessage('end_turn');
  return `chose ${choice}`;
});

scenario(/todo/i, async (t) => {
  const items = ['Read the code', 'Write the fix', 'Run the tests'];
  const active = ['Reading the code', 'Writing the fix', 'Running the tests'];
  t.newMessage();
  await t.text("Here's my plan.");
  for (let step = 0; step <= items.length; step++) {
    t.check();
    const todos = items.map((content, i) => ({
      content,
      activeForm: active[i],
      status: i < step ? 'completed' : i === step ? 'in_progress' : 'pending',
    }));
    const id = await t.toolUse('TodoWrite', { todos });
    t.toolResult(id, 'Todos have been modified successfully.', {
      structured: { oldTodos: [], newTodos: todos },
    });
    await sleep(500);
  }
  await t.text('All three steps are done.');
  t.endMessage('end_turn');
  return 'done';
});

scenario(/agent|task/i, async (t) => {
  t.newMessage();
  const id = await t.toolUse('Task', {
    description: 'Inspect the repo',
    prompt: 'List the files and report back.',
    subagent_type: 'general-purpose',
  });
  t.endMessage('tool_use');
  // Sub-agent: full messages with parent_tool_use_id, no stream events.
  const sub = makeTurn();
  sub.parent = id;
  const bashInput = { command: 'ls', description: 'List files' };
  const bid = `toolu_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  sub.assistant({ type: 'tool_use', id: bid, name: 'Bash', input: bashInput });
  await sleep(300);
  sub.toolResult(bid, 'README.md\npackage.json\nsrc', {
    structured: { stdout: 'README.md\npackage.json\nsrc', stderr: '', interrupted: false },
  });
  sub.assistant({ type: 'text', text: 'The repo has README.md, package.json and src.' });
  t.toolResult(id, [{ type: 'text', text: 'The repo has README.md, package.json and src.' }], {
    structured: { status: 'completed' },
  });
  t.newMessage();
  await t.text('The sub-agent found **3 entries**.');
  t.endMessage('end_turn');
  return 'found 3 entries';
});

scenario(/plan/i, async (t) => {
  t.newMessage();
  const plan = '## Plan\n\n1. Add a `--json` flag\n2. Print results as JSON\n3. Document it in the README';
  const input = { plan };
  const id = await t.toolUse('ExitPlanMode', input);
  const r = await canUseTool('ExitPlanMode', input, id);
  if (r.behavior === 'cancelled') throw new Interrupted();
  t.endMessage('tool_use');
  t.newMessage();
  if (r.behavior !== 'allow') {
    t.toolResult(id, r.message || 'The user wants to keep planning.', { isError: true, decision: 'reject' });
    await t.text("OK, let's keep refining the plan.");
  } else {
    t.toolResult(id, 'User has approved your plan. You can now start coding.', { structured: { plan } });
    await t.text(`Plan approved. Mode is now **${mode}**.`);
  }
  t.endMessage('end_turn');
  return 'plan';
});

scenario(/long/i, async (t) => {
  t.newMessage();
  const words = [];
  for (let i = 1; i <= 100; i++) words.push(`word${i}`);
  await t.text(`Here is a long answer: ${words.join(' ')}.`, { delay: 100 });
  t.endMessage('end_turn');
  return 'long';
});

scenario(/compact/i, async (t) => {
  out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: randomUUID() });
  await sleep(300);
  out({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 48000 },
    session_id: sessionId,
    uuid: randomUUID(),
  });
  t.newMessage();
  await t.text('Compacted.');
  t.endMessage('end_turn');
  return 'compacted';
});

scenario(/rate limit/i, async (t) => {
  out({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: 'five_hour',
      utilization: 0.91,
    },
    uuid: randomUUID(),
    session_id: sessionId,
  });
  out({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: 529,
    error: 'overloaded',
    session_id: sessionId,
    uuid: randomUUID(),
  });
  await sleep(300);
  t.newMessage();
  await t.text('Made it through the retries.');
  t.endMessage('end_turn');
  return 'retried';
});

scenario(/./s, async (t, text) => {
  t.newMessage();
  await t.text(`You said: ${text.slice(0, 200)}`);
  t.endMessage('end_turn');
  return 'echo';
});

function promptText(msg) {
  const c = msg.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  return '';
}

let turnIndex = 0;
async function runTurn(msg) {
  const text = promptText(msg);
  const started = Date.now();
  current = { aborted: false, onAbort: new Set() };
  out({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'running',
    sdk_host_only: true,
    uuid: randomUUID(),
    session_id: sessionId,
  });
  out({
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: sessionId,
    tools: [
      'Task',
      'AskUserQuestion',
      'Bash',
      'Edit',
      'ExitPlanMode',
      'Glob',
      'Grep',
      'Read',
      'TodoWrite',
      'WebFetch',
      'WebSearch',
      'Write',
    ],
    mcp_servers: [],
    model,
    permissionMode: mode,
    slash_commands: ['compact'],
    apiKeySource: 'none',
    claude_code_version: '2.1.330',
    output_style: 'default',
    uuid: randomUUID(),
  });
  persist({
    type: 'user',
    message: { role: 'user', content: msg.message?.content ?? text },
    uuid: randomUUID(),
    permissionMode: mode,
  });
  const t = makeTurn();
  const sc = scenarios.find((s) => s.re.test(text));
  let resultText = '';
  let outcome = 'success';
  try {
    resultText = await sc.fn(t, text);
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    outcome = 'interrupted';
    const u = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    out(u);
    persist({ type: 'user', message: u.message, uuid: u.uuid });
    t.stream({ type: 'message_stop' });
  }
  turnIndex++;
  const cost = 0.0012 + 0.0003 * turnIndex;
  totalCost += cost;
  const base = {
    duration_ms: Date.now() - started,
    duration_api_ms: Date.now() - started,
    num_turns: 1,
    stop_reason: outcome === 'success' ? 'end_turn' : null,
    session_id: sessionId,
    total_cost_usd: Number(totalCost.toFixed(6)),
    usage: usage(1200 + turnIndex, 85),
    modelUsage: { [model]: { inputTokens: 1200, outputTokens: 85, costUSD: cost } },
    permission_denials: [],
    uuid: randomUUID(),
    ...(msg.uuid ? { user_message_uuids: [msg.uuid] } : {}),
  };
  if (outcome === 'success')
    out({ type: 'result', subtype: 'success', is_error: false, result: resultText, ...base });
  else out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], ...base });
  out({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    sdk_host_only: true,
    uuid: randomUUID(),
    session_id: sessionId,
  });
  current = null;
}

// Main loop: one turn at a time, in order.
void (async () => {
  for (;;) {
    while (queue.length === 0) await new Promise((r) => (wake = r));
    wake = null;
    const msg = queue.shift();
    if (msg.eof) process.exit(0);
    await runTurn(msg);
  }
})();
