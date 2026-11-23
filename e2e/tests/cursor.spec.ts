/**
 * Cursor's desktop app, followed through its hooks. The tests play Cursor:
 * they run the hook script phone-code installs, as Cursor would (the event as
 * its argument, JSON on stdin, JSON answer on stdout), against the real daemon,
 * and follow and answer the chat from the phone.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Daemon } from '../lib/daemon.ts';
import { expect, test, type Phone } from '../lib/fixtures.ts';
import { isRecord, parse, record } from '../lib/json.ts';
import {
  closeComputer,
  closeSidebar,
  openComputer,
  openSidebar,
  send,
  shot,
  startNewChat,
} from '../lib/ui.ts';

// Cursor counts as installed when its folder exists; hooks.json goes there.
const CURSOR_DIR = mkdtempSync(join(tmpdir(), 'phonecode-e2e-cursor-'));
const HOOKS = join(CURSOR_DIR, 'hooks.json');
// Someone else's hooks are already there: phone-code must keep them.
const FOREIGN = {
  version: 1,
  hooks: { sessionStart: [{ command: 'other-tool session' }], stop: [{ command: 'other-tool stop' }] },
};
writeFileSync(HOOKS, JSON.stringify(FOREIGN));

test.afterAll(() => rmSync(CURSOR_DIR, { recursive: true, force: true }));

test.use({
  daemonOptions: { env: { PHONECODE_CURSOR_DIR: CURSOR_DIR, PHONECODE_CURSOR_HOLD_MS: '20000' } },
});

const CONV = `conv-${Date.now().toString(36)}`;
const PROMPT = 'fix the login bug';
const ANSWER = 'Fixed: the token was compared too early.';
const REPLY = 'now add a test for it';

type Hooks = Record<string, Array<Record<string, unknown>>>;

function hooks(): Hooks {
  const lists = record(parse(readFileSync(HOOKS, 'utf8')))['hooks'];
  const out: Hooks = {};
  for (const [event, list] of Object.entries(isRecord(lists) ? lists : {}))
    out[event] = Array.isArray(list) ? list.filter(isRecord) : [];
  return out;
}

const commands = (list: Array<Record<string, unknown>> | undefined): string[] =>
  (list ?? []).map((h) => String(h['command']));

/** Runs `cursor-hook.sh <event>` as Cursor does; resolves with what it prints. */
function hook(daemon: Daemon, event: string, input: Record<string, unknown>): Promise<unknown> {
  return new Promise((ok, fail) => {
    const p = spawn('sh', [join(daemon.home, 'cursor-hook.sh'), event], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => (out += c.toString()));
    p.once('error', fail);
    p.once('exit', () => {
      try {
        ok(parse(out));
      } catch {
        fail(new Error(`hook ${event} printed ${JSON.stringify(out)}`));
      }
    });
    p.stdin.end(
      JSON.stringify({
        conversation_id: CONV,
        workspace_roots: [daemon.project],
        hook_event_name: event,
        ...input,
      }),
    );
  });
}

const cursorRow = (phone: Phone) =>
  phone.page.locator('[data-testid="session-row"][data-agent="cursor-app"]');

/** Opens the Cursor chat from the sidebar and waits for its transcript (the phone follows it). */
async function openCursorChat(phone: Phone): Promise<void> {
  await openSidebar(phone);
  await cursorRow(phone).click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', /.+/);
  await expect(phone.testId('chat-item-user').first()).toContainText(PROMPT);
}

async function bothThemes(phone: Phone, name: string): Promise<void> {
  await phone.page.emulateMedia({ colorScheme: 'light' });
  await shot(phone, `${name}-light`);
  await phone.page.emulateMedia({ colorScheme: 'dark' });
  await shot(phone, `${name}-dark`);
}

test('a new chat suggests following Cursor; Connect adds the hook and keeps other hooks', async ({
  phone,
}) => {
  const card = phone.testId('cursor-suggestion');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Follow your Cursor chats here');
  await expect(card).toContainText('See them live and reply when a turn ends.');
  await expect(card.locator('[data-glyph="cursor-app"]')).toHaveText('Cu');
  await bothThemes(phone, 'cursor-suggestion');

  // Cursor's chats start in Cursor: it is not a harness for a new chat.
  await phone.testId('composer-harness').click();
  await expect(phone.testId('harness-menu')).toBeVisible();
  await expect(phone.testId('harness-cursor-app')).toHaveCount(0);
  await phone.page.keyboard.press('Escape');
  await expect(phone.testId('harness-menu')).toBeHidden();

  await phone.testId('cursor-connect').click();
  await expect(card).toBeHidden();
  const h = hooks();
  expect(commands(h['stop'])).toContain('other-tool stop');
  expect(commands(h['stop']).some((c) => c.includes('cursor-hook.sh'))).toBe(true);
  expect(commands(h['sessionStart'])).toEqual(['other-tool session']);
  for (const event of [
    'beforeSubmitPrompt',
    'afterAgentThought',
    'afterAgentResponse',
    'postToolUse',
    'afterFileEdit',
  ])
    expect(commands(h[event]).filter((c) => c.includes('cursor-hook.sh'))).toHaveLength(1);
});

test('a Cursor chat shows up live: the prompt as its title, thinking, a command, an edit and the answer', async ({
  phone,
  daemon,
}) => {
  expect(await hook(daemon, 'beforeSubmitPrompt', { generation_id: 'g1', prompt: PROMPT })).toEqual({});
  await openSidebar(phone);
  const row = cursorRow(phone);
  await expect(row).toHaveCount(1);
  await expect(row.locator('.sb-title')).toHaveText(PROMPT);
  await expect(row.locator('[data-glyph="cursor-app"]')).toHaveText('Cu');
  await closeSidebar(phone);
  await openCursorChat(phone);

  // Following along while Cursor works.
  await hook(daemon, 'afterAgentThought', { generation_id: 'g1', text: 'Looking at auth.ts' });
  await hook(daemon, 'postToolUse', {
    generation_id: 'g1',
    tool_name: 'Shell',
    tool_use_id: 't1',
    tool_input: { command: 'npm test' },
    tool_output: '1 failing',
  });
  await hook(daemon, 'afterFileEdit', {
    generation_id: 'g1',
    file_path: join(daemon.project, 'src/auth.ts'),
    edits: [{ old_string: 'if (token == stored)\n', new_string: 'if (await verify(token))\n' }],
  });
  await hook(daemon, 'afterAgentResponse', { generation_id: 'g1', text: ANSWER });

  await expect(phone.testId('chat-item-thinking')).toHaveCount(1);
  const bash = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]');
  await expect(bash).toContainText('npm test');
  const edit = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Edit"]');
  await expect(edit).toContainText('auth.ts');
  await expect(edit.locator('.diff-counts')).toContainText('+1');
  await edit.locator('.tool-head').click();
  await expect(edit.getByTestId('diff-view')).toContainText('verify(token)');
  await expect(phone.testId('chat-item-text').last()).toContainText(ANSWER);

  // No modes, models or thinking levels to switch: Cursor's app has its own.
  await expect(phone.testId('composer-harness')).toHaveText('Cursor');
  await expect(phone.testId('composer-mode')).toHaveCount(0);
  await expect(phone.testId('composer-model')).toHaveCount(0);
  await expect(phone.testId('composer-effort')).toHaveCount(0);
});

test('when Cursor finishes a turn, the reply typed here goes back to it as its next message', async ({
  phone,
  daemon,
}) => {
  await openCursorChat(phone);
  await expect(phone.testId('chat-item-text').last()).toContainText(ANSWER);

  // The turn ends while the phone follows the chat: the hook waits for a reply.
  const stopped = hook(daemon, 'stop', { generation_id: 'g1', status: 'completed', loop_count: 0 });
  await expect(phone.testId('chat-title')).toContainText('Needs you');
  await expect(phone.testId('chat-item-turn')).toHaveCount(1);
  await openSidebar(phone);
  await expect(phone.testId('section-waiting').locator('[data-agent="cursor-app"]')).toContainText('Reply');
  await closeSidebar(phone);
  // Nothing to stop or approve: the composer just takes the reply.
  await expect(phone.testId('composer-stop')).toHaveCount(0);
  await expect(phone.testId('composer-mode')).toHaveCount(0);
  await expect(phone.testId('composer-input')).toHaveAttribute('placeholder', 'Message Cursor');
  await bothThemes(phone, 'cursor-chat');

  await send(phone, REPLY);
  expect(await stopped).toEqual({ followup_message: REPLY });
  await expect(phone.testId('chat-item-user')).toHaveCount(2);
  await expect(phone.testId('chat-item-user').last()).toContainText(REPLY);

  // Cursor submits it as the chat's next message: no second copy.
  expect(await hook(daemon, 'beforeSubmitPrompt', { generation_id: 'g2', prompt: REPLY })).toEqual({});
  await expect(phone.testId('chat-title')).toContainText('Working');
  await expect(phone.testId('chat-item-user')).toHaveCount(2);
  // Stopped in Cursor: nothing to wait for.
  expect(await hook(daemon, 'stop', { generation_id: 'g2', status: 'aborted', loop_count: 1 })).toEqual({});
  await expect(phone.testId('chat-title')).toContainText('Ready');
  await expect(phone.testId('chat-item-turn')).toHaveCount(2);
});

test('This computer: the switch stops following Cursor (only its hook goes), and says why it cannot', async ({
  phone,
}) => {
  await openComputer(phone);
  const section = phone.testId('settings-cursor');
  await expect(section).toContainText('Follow Cursor chats');
  await expect(section).toContainText('keeps your other hooks');
  const toggle = phone.testId('cursor-toggle');
  await expect(toggle).toBeChecked();
  await section.scrollIntoViewIfNeeded();
  await bothThemes(phone, 'cursor-settings');

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  const h = hooks();
  expect(commands(h['stop'])).toEqual(['other-tool stop']);
  expect(commands(h['sessionStart'])).toEqual(['other-tool session']);
  expect(h['afterAgentResponse']).toBeUndefined();

  // A hooks.json phone-code cannot read is never overwritten: the switch says so and stays off.
  const good = readFileSync(HOOKS, 'utf8');
  writeFileSync(HOOKS, '{ not json');
  await toggle.click();
  await expect(phone.testId('cursor-error')).toContainText('not valid JSON');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(readFileSync(HOOKS, 'utf8')).toBe('{ not json');
  writeFileSync(HOOKS, good);
  await closeComputer(phone);

  // Not connected again: the suggestion is back, and once dismissed it stays away.
  await closeSidebar(phone);
  await startNewChat(phone);
  await expect(phone.testId('cursor-suggestion')).toBeVisible();
  await phone.testId('cursor-dismiss').click();
  await expect(phone.testId('cursor-suggestion')).toBeHidden();
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  await expect(phone.testId('new-chat-empty')).toBeVisible();
  await expect(phone.testId('cursor-suggestion')).toHaveCount(0);
});
