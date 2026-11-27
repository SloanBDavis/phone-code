/** An ACP agent (the built-in Gemini CLI preset) driven by the scripted ACP fake. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { REPO } from '../lib/daemon.ts';
import {
  currentId,
  newChat,
  lastText,
  openSidebar,
  row,
  searchAll,
  send,
  shot,
  waitTurn,
} from '../lib/ui.ts';

const FAKE = join(REPO, 'e2e/fakes/fake-acp.mjs');
// The Antigravity preset runs the same fake, for its preset-specific rules.
test.use({ daemonOptions: { env: { PHONECODE_GEMINI_BIN: FAKE, PHONECODE_ANTIGRAVITY_BIN: FAKE } } });

test('streams an answer from Gemini CLI', async ({ phone }) => {
  await phone.testId('composer-harness').click();
  await expect(phone.testId('harness-gemini')).toContainText('Gemini CLI');
  await phone.page.keyboard.press('Escape');
  await newChat(phone, 'gemini');
  await expect(phone.testId('composer-input')).toHaveAttribute('placeholder', 'Message Gemini CLI');
  // An ACP agent names its models only inside a session: the first chat ever has none to pick.
  await expect(phone.testId('composer-model')).toHaveCount(0);
  await send(phone, 'hello gemini');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false');
  await expect(lastText(phone).locator('strong, code, li').first()).toBeVisible();
  await shot(phone, 'acp-hello');
});

test('a new chat offers the models the agent named in its last session, and starts with the one picked', async ({
  phone,
}) => {
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  await newChat(phone, 'gemini');
  await phone.testId('composer-model').click();
  await phone.testId('model-menu').getByTestId('model-fake-flash').click();
  await expect(phone.testId('composer-model')).toHaveText('fake-flash');
  await send(phone, 'hello again');
  await waitTurn(phone, 1);
  await expect(phone.testId('composer-model')).toHaveText('fake-flash');
});

test('permissions: allow, deny (no feedback), always allow', async ({ phone }) => {
  await newChat(phone, 'gemini');
  const perm = phone.testId('chat-item-permission');
  await send(phone, 'run tests');
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'pending');
  // ACP rejections carry no reason, so there is no "deny with feedback".
  await expect(perm.nth(0).getByTestId('permission-deny-feedback')).toHaveCount(0);
  await shot(phone, 'acp-perm');
  await perm.nth(0).getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  await expect(phone.testId('transcript').locator('table')).toBeVisible();

  await send(phone, 'run tests again');
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'pending');
  await perm.nth(1).getByTestId('permission-deny').click();
  await waitTurn(phone, 2);
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'denied');

  await send(phone, 'run tests always');
  await perm.nth(2).getByTestId('permission-allow-always').click();
  await waitTurn(phone, 3);
  await send(phone, 'run tests silently');
  await waitTurn(phone, 4);
  await expect(perm).toHaveCount(3);
});

test('edits go through the client and change the file; reads outside the folder are refused', async ({
  phone,
  daemon,
}) => {
  await newChat(phone, 'gemini', { folder: daemon.folder('edit-acp') });
  const file = join(daemon.userHome, 'edit-acp', 'notes.md');
  writeFileSync(file, '# Notes\n\nhello world\n');
  await send(phone, 'edit file');
  const perm = phone.testId('chat-item-permission').last();
  await expect(perm.getByTestId('diff-view')).toContainText('hello phone-code');
  await perm.getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  expect(readFileSync(file, 'utf8')).toContain('hello phone-code');

  await send(phone, 'read outside please');
  await waitTurn(phone, 2);
  // The adapter refuses: the agent reports the failure instead of the file's content.
  await expect(lastText(phone)).toContainText(/outside|denied|refused|could not|couldn't/i);
});

test('agent terminal, plan, interrupt and crash recovery', async ({ phone }) => {
  await newChat(phone, 'gemini');
  await send(phone, 'use the terminal');
  const perm = phone.testId('chat-item-permission').last();
  await perm.getByTestId('permission-allow').click();
  await waitTurn(phone, 1);

  await send(phone, 'make a plan');
  await expect(phone.testId('chat-item-todo').last()).toBeVisible();
  await waitTurn(phone, 2);
  await expect(phone.testId('chat-item-todo').last().locator('.todo-progress')).toHaveText('3 of 3');

  await send(phone, 'something long');
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'true');
  await phone.testId('composer-stop').click();
  await waitTurn(phone, 3, 'interrupted');

  await send(phone, 'crash now');
  await expect(phone.testId('chat-item-notice').last()).toBeVisible();
  await waitTurn(phone, 4, 'error');
  await send(phone, 'hello, are you back?');
  await waitTurn(phone, 5);
  await expect(phone.testId('chat-title')).toContainText('Ready');
});

test('an agent that stops reading its input: an error, and the next message restarts it', async ({
  phone,
}) => {
  await newChat(phone, 'gemini');
  await send(phone, 'close input');
  await waitTurn(phone, 1);
  // Long enough that the write fails (Bun reports EPIPE only for writes it cannot finish at once).
  await send(phone, `are you there ${'z'.repeat(20_000)}`);
  await expect(phone.testId('chat-item-notice').last()).toContainText('stopped reading its input');
  await waitTurn(phone, 2, 'error');
  await expect(phone.testId('chat-title')).toContainText('Error');
  await send(phone, 'hello, are you back?');
  await waitTurn(phone, 3);
  await expect(phone.testId('chat-title')).toContainText('Ready');
});

test('stop cancels a permission asked after the prompt ended', async ({ phone }) => {
  await newChat(phone, 'gemini');
  await send(phone, 'late ask');
  await waitTurn(phone, 1);
  const perm = phone.testId('chat-item-permission').last();
  await expect(perm).toHaveAttribute('data-status', 'pending');
  await phone.testId('composer-stop').click();
  await expect(perm).toHaveAttribute('data-status', 'cancelled');
  await expect(phone.testId('chat-title')).toContainText('Ready');
  await send(phone, 'background decision?');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('Background request: cancelled');
});

test('question form: single choice, multiple choice and free text reach the agent', async ({ phone }) => {
  await newChat(phone, 'gemini');
  await send(phone, 'ask me');
  const q = phone.testId('chat-item-question');
  await expect(q).toHaveAttribute('data-status', 'pending');
  const blocks = q.locator('fieldset');
  await expect(blocks).toHaveCount(3); // the `_other` fields are folded into their questions
  await expect(blocks.nth(0)).toContainText('Which color?');
  await blocks.nth(0).getByTestId('question-option').filter({ hasText: 'Red' }).click();
  await blocks.nth(1).getByTestId('question-option').filter({ hasText: 'iOS' }).click();
  await blocks.nth(1).getByTestId('question-option').filter({ hasText: 'Web' }).click();
  await blocks.nth(2).getByTestId('question-other').click();
  await blocks.nth(2).getByTestId('question-other-input').fill('GPL-3.0');
  // The card stands for the agent's ask_question tool call: no separate tool row.
  await expect(phone.testId('chat-item-tool').filter({ hasText: 'ask_question' })).toHaveCount(0);
  await shot(phone, 'acp-question');
  await q.getByTestId('question-submit').click();
  await expect(q).toHaveAttribute('data-status', 'answered');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toContainText('Received: {"q1":"2","q2":["ios","web"],"q3_other":"GPL-3.0"}');
  await expect(phone.testId('chat-item-tool').filter({ hasText: 'ask_question' })).toHaveCount(0);
});

test("thinking level: the agent's own levels, through its config option", async ({ phone }) => {
  await newChat(phone, 'gemini');
  const chip = phone.testId('composer-effort');
  const menu = phone.testId('effort-menu');
  await send(phone, 'hello gemini');
  await waitTurn(phone, 1);
  await expect(chip).toHaveText('Medium');
  await chip.click();
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await expect(menu.getByTestId('effort-medium')).toHaveClass(/\bchecked\b/);
  await menu.getByTestId('effort-deep').click();
  await expect(chip).toHaveText('Deep think');
  await send(phone, 'what is your thinking level');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('Thinking level: deep');

  // The next new chat offers that model's levels before its first message, and starts on the one picked.
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  await newChat(phone, 'gemini');
  await phone.testId('composer-model').click();
  await phone.testId('model-menu').getByTestId('model-fake-pro').click();
  await chip.click();
  await menu.getByTestId('effort-deep').click();
  await send(phone, 'what is your thinking level');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toContainText('Thinking level: deep');
});

test('Antigravity: an executor error sent as a reply is an error, for that preset only', async ({
  phone,
}) => {
  await newChat(phone, 'antigravity');
  await send(phone, 'model error');
  await waitTurn(phone, 1, 'error');
  await expect(phone.testId('chat-item-notice').last()).toContainText(
    'agent executor error: model unavailable (RESOURCE_EXHAUSTED)',
  );
  await expect(phone.testId('chat-item-text')).toHaveCount(0);
  await send(phone, 'hello');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('fake ACP agent');

  // The same words from another agent are just its answer.
  await newChat(phone, 'gemini');
  await send(phone, 'model error');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toContainText('agent executor error');
  await expect(phone.testId('chat-item-notice')).toHaveCount(0);
});

test('bypass permissions for an agent with no such mode: phone-code allows what it asks', async ({
  phone,
}) => {
  await newChat(phone, 'antigravity');
  const perm = phone.testId('chat-item-permission');
  await send(phone, 'run tests');
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'pending');
  // Its own modes are Default and Plan; Bypass is offered all the same.
  await phone.testId('composer-mode').click();
  await expect(phone.testId('mode-menu').getByTestId('mode-acceptEdits')).toHaveCount(0);
  await phone.testId('mode-menu').getByTestId('mode-bypassPermissions').click();
  // The request that was waiting is allowed, and the next one is never asked.
  await waitTurn(phone, 1);
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'allowed');
  await send(phone, 'run tests again');
  await waitTurn(phone, 2);
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'allowed');
  await expect(phone.page.locator('[data-testid="chat-item-permission"][data-status="pending"]')).toHaveCount(
    0,
  );
  // Back to asking.
  await phone.testId('composer-mode').click();
  await phone.testId('mode-menu').getByTestId('mode-default').click();
  await send(phone, 'run tests once more');
  await expect(perm.nth(2)).toHaveAttribute('data-status', 'pending');
  await perm.nth(2).getByTestId('permission-deny').click();
  await waitTurn(phone, 3);
});

test('resumes a past Gemini session from history', async ({ phone, daemon }) => {
  await newChat(phone, 'gemini', { folder: daemon.folder('resume-acp') });
  await send(phone, 'hello, remember the word walrus');
  const id = await currentId(phone);
  await waitTurn(phone, 1);
  await phone.testId('chat-title').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog-confirm').click();
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveCount(0);
  // "All chats" still finds the conversation on the computer, and continues it.
  const rows = await searchAll(phone, 'walrus');
  await rows.filter({ hasText: 'walrus' }).first().click();
  await expect(phone.testId('chat-item-user').first()).toContainText('walrus');
  await expect(phone.testId('chat-item-text').first()).not.toHaveText('');
  await send(phone, 'hello once more');
  await expect(phone.testId('chat-item-user')).toHaveCount(2);
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false', { timeout: 15_000 });
});

test('a user-defined agent from agents.json', async ({ phone, daemon }) => {
  writeFileSync(
    join(daemon.home, 'agents.json'),
    JSON.stringify({ agents: [{ id: 'my-agent', name: 'My Agent', command: FAKE }] }),
  );
  phone.allowConsole(/WebSocket connection to .* failed/);
  await daemon.restart();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  await newChat(phone, 'my-agent');
  await expect(phone.testId('composer-input')).toHaveAttribute('placeholder', 'Message My Agent');
  await send(phone, 'hello mine');
  await waitTurn(phone, 1);
});
