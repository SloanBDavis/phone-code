/** An ACP agent (the built-in Gemini CLI preset) driven by the scripted ACP fake. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { REPO } from '../lib/daemon.ts';
import { back, createSession, lastText, row, send, shot, waitTurn } from '../lib/ui.ts';

const FAKE = join(REPO, 'e2e/fakes/fake-acp.mjs');
test.use({ daemonOptions: { env: { PHONECODE_GEMINI_BIN: FAKE } } });

test('streams an answer from Gemini CLI', async ({ phone }) => {
  await phone.testId('new-session').click();
  await expect(phone.testId('new-kind-gemini')).toContainText('Gemini CLI');
  await phone.testId('new-session-close').click();
  await createSession(phone, 'gemini');
  await expect(phone.testId('composer-input')).toHaveAttribute('placeholder', 'Message Gemini CLI');
  await send(phone, 'hello gemini');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false');
  await expect(lastText(phone).locator('strong, code, li').first()).toBeVisible();
  await shot(phone, 'acp-hello');
});

test('permissions: allow, deny (no feedback), always allow', async ({ phone }) => {
  await createSession(phone, 'gemini');
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
  await createSession(phone, 'gemini', { folder: daemon.folder('edit-acp') });
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
  await createSession(phone, 'gemini');
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

test('resumes a past Gemini session from history', async ({ phone, daemon }) => {
  const id = await createSession(phone, 'gemini', { folder: daemon.folder('resume-acp') });
  await send(phone, 'hello, remember the word walrus');
  await waitTurn(phone, 1);
  await phone.testId('chat-menu-btn').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog-confirm').click();
  await expect(row(phone, id)).toHaveCount(0);
  await phone.testId('new-session').click();
  await phone.testId('new-kind-gemini').click();
  await phone.testId('resume-row').filter({ hasText: 'walrus' }).click();
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
  await createSession(phone, 'my-agent');
  await expect(phone.testId('composer-input')).toHaveAttribute('placeholder', 'Message My Agent');
  await send(phone, 'hello mine');
  await waitTurn(phone, 1);
  await back(phone);
});
