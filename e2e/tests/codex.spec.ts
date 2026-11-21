import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { createSession, lastText, send, SHOTS, waitTurn } from '../lib/ui.ts';

test('streams an answer', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'codex');
  await send(phone, 'hello codex');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false');
  await expect(lastText(phone)).not.toHaveText('');
  await phone.page.screenshot({ path: `${SHOTS}codex-hello.png` });
});

test('command approval: allow, deny, allow for the session', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'codex');
  const perm = phone.testId('chat-item-permission');
  await send(phone, 'run tests');
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'pending');
  await expect(perm.nth(0)).toContainText('npm test');
  await phone.page.screenshot({ path: `${SHOTS}codex-perm.png` });
  await perm.nth(0).getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'allowed');
  const tool = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]').first();
  await expect(tool).toHaveAttribute('data-status', 'done');
  await tool.locator('.tool-head').click();
  await expect(tool).toContainText('pass');

  await send(phone, 'run tests again');
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'pending');
  await perm.nth(1).getByTestId('permission-deny-feedback').click();
  await perm.nth(1).getByTestId('permission-deny-message').fill('not now');
  await perm.nth(1).getByTestId('permission-deny-send').click();
  await waitTurn(phone, 2);
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'denied');

  await send(phone, 'run tests always');
  await expect(perm.nth(2)).toHaveAttribute('data-status', 'pending');
  await perm.nth(2).getByTestId('permission-allow-always').click();
  await waitTurn(phone, 3);
  await send(phone, 'run tests without asking');
  await waitTurn(phone, 4);
  await expect(perm).toHaveCount(3);
});

test('file change approval with a diff, the file changes on disk', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'codex', { folder: daemon.folder('edit-codex') });
  const file = join(daemon.userHome, 'edit-codex', 'notes.md');
  await send(phone, 'edit file');
  let perm = phone.testId('chat-item-permission').last();
  await expect(perm).toHaveAttribute('data-status', 'pending');
  await perm.getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  expect(readFileSync(file, 'utf8')).toContain('hello');
  const before = readFileSync(file, 'utf8');

  await send(phone, 'edit file again');
  perm = phone.testId('chat-item-permission').last();
  await expect(perm).toHaveAttribute('data-status', 'pending');
  await expect(perm.getByTestId('diff-view')).toBeVisible();
  await perm.getByTestId('permission-allow').click();
  await waitTurn(phone, 2);
  expect(readFileSync(file, 'utf8')).not.toBe(before);
  const edit = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Edit"]').last();
  await expect(edit).toHaveAttribute('data-status', 'done');
});

test('question, plan and interrupt', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'codex');
  await send(phone, 'ask me');
  const q = phone.testId('chat-item-question');
  await expect(q).toHaveAttribute('data-status', 'pending');
  await q.getByTestId('question-other').click();
  await q.getByTestId('question-other-input').fill('my own answer');
  await q.getByTestId('question-submit').click();
  await expect(q).toHaveAttribute('data-status', 'answered');
  await expect(q).toContainText('my own answer');
  await waitTurn(phone, 1);

  await send(phone, 'make a plan');
  const todo = phone.testId('chat-item-todo').last();
  await expect(todo).toBeVisible();
  await waitTurn(phone, 2);
  await expect(todo.locator('.todo-progress')).toHaveText(/(\d+) of \1/);

  await send(phone, 'something long');
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'true');
  await phone.testId('composer-stop').click();
  await waitTurn(phone, 3, 'interrupted');
});

test('crash and recovery', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'codex');
  await send(phone, 'crash please');
  await expect(phone.testId('chat-item-notice').last()).toBeVisible();
  await waitTurn(phone, 1, 'error');
  await send(phone, 'hello, are you back?');
  await waitTurn(phone, 2);
  await expect(phone.testId('chat-title')).toContainText('Ready');
});

test('model and mode switching', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'codex');
  await phone.testId('composer-model').click();
  const items = phone.testId('model-menu').getByRole('menuitem');
  const second = (await items.nth(1).innerText()).trim();
  await items.nth(1).click();
  await expect(phone.testId('composer-model')).toContainText(second);
  await phone.testId('composer-mode').click();
  await phone.testId('mode-menu').getByTestId('mode-bypassPermissions').click();
  await expect(phone.testId('composer-mode')).toHaveText(/Bypass/);
  // Bypass: commands run without approval.
  await send(phone, 'run tests');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-item-permission')).toHaveCount(0);
  await expect(phone.testId('composer-model')).toContainText(second);
});
