import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { createSession, lastText, send, waitTurn } from '../lib/ui.ts';

test('streams a markdown answer', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'claude');
  await send(phone, 'hello there');
  await expect(phone.testId('chat-item-user')).toContainText('hello there');
  await waitTurn(phone, 1);
  const text = lastText(phone);
  await expect(text).toHaveAttribute('data-streaming', 'false');
  await expect(text.locator('strong, code, li').first()).toBeVisible();
  await phone.page.screenshot({ path: '/tmp/claude-0/-home-user/27c9d6d3-57b8-58f0-81fd-e737536b93db/scratchpad/e2e/chat-hello.png' });
});

test('Bash permission: allow, deny, deny with feedback, always allow', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'claude');
  const perm = phone.testId('chat-item-permission');

  await send(phone, 'run tests please');
  await expect(perm.last()).toHaveAttribute('data-status', 'pending');
  await expect(perm.last()).toContainText('npm test');
  await phone.page.screenshot({ path: '/tmp/claude-0/-home-user/27c9d6d3-57b8-58f0-81fd-e737536b93db/scratchpad/e2e/chat-perm.png' });
  await perm.last().getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'allowed');
  await expect(phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]').first()).toHaveAttribute('data-status', 'done');
  await expect(phone.testId('transcript').locator('table')).toBeVisible();

  await send(phone, 'run tests again');
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'pending');
  await perm.nth(1).getByTestId('permission-deny').click();
  await waitTurn(phone, 2);
  await expect(perm.nth(1)).toHaveAttribute('data-status', 'denied');

  await send(phone, 'run tests once more');
  await expect(perm.nth(2)).toHaveAttribute('data-status', 'pending');
  await perm.nth(2).getByTestId('permission-deny-feedback').click();
  await perm.nth(2).getByTestId('permission-deny-message').fill('use bun test instead');
  await perm.nth(2).getByTestId('permission-deny-send').click();
  await waitTurn(phone, 3);
  await expect(perm.nth(2)).toHaveAttribute('data-status', 'denied');
  await expect(phone.testId('transcript')).toContainText('use bun test instead');

  await send(phone, 'run tests, always');
  await expect(perm.nth(3)).toHaveAttribute('data-status', 'pending');
  await perm.nth(3).getByTestId('permission-allow-always').click();
  await waitTurn(phone, 4);
  // Now the same command runs without asking.
  await send(phone, 'run tests one last time');
  await waitTurn(phone, 5);
  await expect(perm).toHaveCount(4);
});

test('Edit shows a diff and really changes the file', async ({ phone, daemon }) => {
  await createSession(phone, daemon, 'claude');
  const file = join(daemon.project, 'notes.md');
  await send(phone, 'edit file');
  const perm = phone.testId('chat-item-permission').last();
  await expect(perm).toHaveAttribute('data-status', 'pending');
  await perm.getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  expect(readFileSync(file, 'utf8')).toContain('hello world');

  await send(phone, 'edit file again');
  const perm2 = phone.testId('chat-item-permission').last();
  await expect(perm2).toHaveAttribute('data-status', 'pending');
  await expect(perm2.getByTestId('diff-view')).toBeVisible();
  await expect(perm2.getByTestId('diff-view')).toContainText('hello phone-code');
  await perm2.getByTestId('permission-allow').click();
  await waitTurn(phone, 2);
  expect(readFileSync(file, 'utf8')).toContain('hello phone-code');
  const edit = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Edit"]').last();
  await expect(edit).toHaveAttribute('data-status', 'done');
  await edit.locator('.tool-head').click();
  await expect(edit.getByTestId('diff-view')).toContainText('hello phone-code');
  await phone.page.screenshot({ path: '/tmp/claude-0/-home-user/27c9d6d3-57b8-58f0-81fd-e737536b93db/scratchpad/e2e/chat-diff.png' });
});
