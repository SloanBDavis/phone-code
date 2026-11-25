import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import {
  lastText,
  newChat,
  openSidebar,
  row,
  searchAll,
  send,
  shot,
  startChat,
  waitTurn,
} from '../lib/ui.ts';

test('streams a markdown answer', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'hello there');
  await expect(phone.testId('chat-item-user')).toContainText('hello there');
  await waitTurn(phone, 1);
  const text = lastText(phone);
  await expect(text).toHaveAttribute('data-streaming', 'false');
  await expect(text.locator('strong, code, li').first()).toBeVisible();
  await shot(phone, 'chat-hello');
});

test('Bash permission: allow, deny, deny with feedback, always allow', async ({ phone }) => {
  await newChat(phone, 'claude');
  const perm = phone.testId('chat-item-permission');

  await send(phone, 'run tests please');
  await expect(perm.last()).toHaveAttribute('data-status', 'pending');
  await expect(perm.last()).toContainText('npm test');
  await shot(phone, 'chat-perm');
  await perm.last().getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  await expect(perm.nth(0)).toHaveAttribute('data-status', 'allowed');
  await expect(
    phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]').first(),
  ).toHaveAttribute('data-status', 'done');
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
  // The feedback reaches the agent as the tool's result.
  const denied = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]').nth(2);
  await expect(denied).toHaveAttribute('data-status', 'denied');
  await denied.locator('.tool-head').click();
  await expect(denied).toContainText('use bun test instead');

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
  await newChat(phone, 'claude', { folder: daemon.folder('edit-claude') });
  const file = join(daemon.userHome, 'edit-claude', 'notes.md');
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
  await shot(phone, 'chat-diff');
});

test('question card is answered', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'ask me something');
  const q = phone.testId('chat-item-question');
  await expect(q).toHaveAttribute('data-status', 'pending');
  await expect(q).toContainText('Which package manager should I use?');
  await shot(phone, 'chat-question');
  await q.getByTestId('question-option').first().click();
  await q.getByTestId('question-submit').click();
  await expect(q).toHaveAttribute('data-status', 'answered');
  await waitTurn(phone, 1);
  // The agent got the answer back.
  const label = await q.locator('.q-resolved-a').first().innerText();
  await expect(lastText(phone)).toContainText(label.trim());
});

test('todo list updates live', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'make a todo list');
  const todo = phone.testId('chat-item-todo').last();
  await expect(todo).toBeVisible();
  await expect(todo.locator('.todo-progress')).toHaveText('3 of 3', { timeout: 15_000 });
  await waitTurn(phone, 1);
});

test('interrupting a long stream', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'tell me something long');
  const text = lastText(phone);
  await expect(text).toHaveAttribute('data-streaming', 'true');
  await expect(text).not.toHaveText('');
  await phone.testId('composer-stop').click();
  await waitTurn(phone, 1, 'interrupted');
  await expect(text).toHaveAttribute('data-streaming', 'false');
  const words = (await text.innerText()).split(/\s+/).length;
  expect(words).toBeLessThan(100);
  // The session is usable again.
  await send(phone, 'hello again');
  await waitTurn(phone, 2);
});

test('a crash shows an error and the next message recovers', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'please crash now');
  const notice = phone.testId('chat-item-notice').last();
  await expect(notice).toContainText(/exited unexpectedly/);
  await waitTurn(phone, 1, 'error');
  await expect(phone.testId('chat-title')).toContainText('Error');
  await shot(phone, 'chat-crash');
  await send(phone, 'hello, are you back?');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('fake Claude');
  await expect(phone.testId('chat-title')).toContainText('Ready');
});

test('a CLI that stops reading its input: an error, and the next message restarts it', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'close input');
  await waitTurn(phone, 1);
  // Long enough that the write fails (Bun reports EPIPE only for writes it cannot finish at once).
  await send(phone, `are you there ${'z'.repeat(20_000)}`);
  await expect(phone.testId('chat-item-notice').last()).toContainText('stopped reading its input');
  await waitTurn(phone, 2, 'error');
  await expect(phone.testId('chat-title')).toContainText('Error');
  await send(phone, 'hello, are you back?');
  await waitTurn(phone, 3);
  await expect(lastText(phone)).toContainText('fake Claude');
  await expect(phone.testId('chat-title')).toContainText('Ready');
});

test('stop cancels a permission asked after the turn ended', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'late ask');
  await waitTurn(phone, 1);
  const perm = phone.testId('chat-item-permission').last();
  await expect(perm).toHaveAttribute('data-status', 'pending');
  await expect(perm).toContainText('git fetch');
  await phone.testId('composer-stop').click();
  await expect(perm).toHaveAttribute('data-status', 'cancelled');
  await expect(phone.testId('chat-title')).toContainText('Ready');
  // The CLI was told, so it does not wait for an answer.
  await send(phone, 'background decision?');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('Background request: deny (interrupt)');
});

test('thinking text is streamed', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'think first');
  await waitTurn(phone, 1);
  const thinking = phone.testId('chat-item-thinking');
  await expect(thinking).toHaveCount(1);
  await thinking.locator('.thinking-head').click();
  await expect(thinking.locator('.thinking-body')).toContainText('consider the options');
});

test('resuming restores the sub-agent tool calls inside the agent card', async ({ phone, daemon }) => {
  const id = await startChat(phone, 'claude', 'start an agent for the walrus', {
    folder: daemon.folder('resume-agent'),
  });
  await waitTurn(phone, 1);
  const task = phone.testId('chat-item-task');
  await expect(task.locator('.task-count')).toHaveText('1 step');
  // What the sub-agent said and thought is inside its card, not in the main thread;
  // its last message is the report, shown once.
  await expect(task.getByTestId('task-say')).toHaveText('Looking at the top level first.');
  await expect(task.getByTestId('task-thought')).toHaveText('A listing is enough here.');
  await expect(task.locator('.task-result')).toContainText('README.md, package.json and src');
  await expect(phone.page.getByText('Looking at the top level first.')).toHaveCount(1);
  await expect(phone.testId('chat-item-text')).toHaveCount(1);
  await phone.testId('chat-title').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog-confirm').click();
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveCount(0);

  await (await searchAll(phone, 'walrus')).filter({ hasText: 'walrus' }).first().click();
  await expect(phone.testId('screen-chat')).toBeVisible();
  await expect(task.locator('.task-count')).toHaveText('1 step');
  await expect(task.getByTestId('task-say')).toHaveText('Looking at the top level first.');
  const nested = task.locator('[data-testid="chat-item-tool"][data-tool="Bash"]');
  await expect(nested).toHaveAttribute('data-status', 'done');
  // Nested only: no top-level Bash row.
  await expect(phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]')).toHaveCount(1);
});

test('switching permission mode and model', async ({ phone, daemon }) => {
  await newChat(phone, 'claude', { folder: daemon.folder('modes-claude') });
  await phone.testId('composer-mode').click();
  await phone.testId('mode-menu').getByTestId('mode-acceptEdits').click();
  await expect(phone.testId('composer-mode')).toHaveText(/Edits/);
  // acceptEdits: the edit goes through without asking.
  await send(phone, 'edit file');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-item-permission')).toHaveCount(0);
  expect(readFileSync(join(daemon.userHome, 'modes-claude', 'notes.md'), 'utf8')).toContain('hello');

  await phone.testId('composer-model').click();
  await phone.testId('model-menu').getByTestId('model-opus').click();
  await expect(phone.testId('composer-model')).toHaveText('Opus Fake');
  await send(phone, 'hello with opus');
  await waitTurn(phone, 2);
  await expect(phone.testId('composer-model')).toHaveText('Opus Fake');
  await expect(phone.testId('composer-mode')).toHaveText(/Edits/);
});

test('thinking level: picked before the first message, changed in the chat, gone with Haiku', async ({
  phone,
}) => {
  await newChat(phone, 'claude');
  const chip = phone.testId('composer-effort');
  const menu = phone.testId('effort-menu');
  // Nothing chosen yet: the user's own Claude Code setting.
  await expect(chip).toHaveText('Default');
  await chip.click();
  await expect(menu.getByTestId('effort-default')).toHaveClass(/\bchecked\b/);
  await expect(menu.getByTestId('effort-xhigh')).toContainText('Extra high');
  await menu.getByTestId('effort-max').click();
  await expect(chip).toHaveText('Max');
  await send(phone, 'what is your thinking level');
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toContainText('Thinking level: max');
  // What the CLI reports it is using.
  await expect(chip).toHaveText('Max');

  await chip.click();
  await expect(menu.getByTestId('effort-max')).toHaveClass(/\bchecked\b/);
  await menu.getByTestId('effort-low').click();
  await expect(chip).toHaveText('Low');
  await send(phone, 'what is your thinking level now');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('Thinking level: low');

  // Haiku has no thinking levels.
  await phone.testId('composer-model').click();
  await phone.testId('model-menu').getByTestId('model-haiku').click();
  await expect(phone.testId('composer-model')).toHaveText('Haiku Fake');
  await expect(chip).toHaveCount(0);
  await phone.testId('composer-model').click();
  await phone.testId('model-menu').getByTestId('model-opus').click();
  await expect(chip).toHaveText('Low');
});

// 8x8 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC',
  'base64',
);

test('attaching a photo', async ({ phone, daemon }) => {
  await newChat(phone, 'claude');
  await phone.testId('composer-file').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await expect(phone.testId('composer').locator('.att img')).toBeVisible();
  await send(phone, 'what is in this photo');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-item-user').locator('img')).toBeVisible();
  // The agent received an image block.
  await expect(lastText(phone)).toContainText('You said');
  await expect.poll(() => claudeTranscript(daemon.userHome)).toContain('"type":"image"');
});

function claudeTranscript(home: string): string {
  const root = join(home, '.claude', 'projects');
  let out = '';
  for (const dir of readdirSync(root)) {
    for (const f of readdirSync(join(root, dir))) {
      if (f.endsWith('.jsonl')) out += readFileSync(join(root, dir, f), 'utf8');
    }
  }
  return out;
}

test('a command started in the background: its card keeps running and shows the output as it grows', async ({
  phone,
  daemon,
}) => {
  await startChat(phone, 'claude', 'start the dev server', { folder: daemon.folder('background') });
  await waitTurn(phone, 1);
  // The turn is over; the command is not.
  const tool = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]');
  await expect(tool).toHaveAttribute('data-status', 'running');
  await expect(tool).toHaveAttribute('data-background', 'true');
  await tool.locator('.tool-head').click();
  await expect(tool).toContainText('ready on http://localhost:3000');
  await expect(tool).toContainText('compiled in 120ms');
  // The strip above the composer names what is still running.
  await expect(phone.testId('running-strip')).toContainText('npm run dev');
  await shot(phone, 'claude-background');
  await expect(tool).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(tool).toContainText('server closed');
  await expect(phone.testId('running-strip')).toHaveCount(0);
});
