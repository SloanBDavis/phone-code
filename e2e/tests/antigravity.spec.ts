/**
 * Antigravity (`agy acp`), played by the scripted ACP fake started as `acp` (see
 * e2e/fakes/README.md): its artifacts as documents, its command reports, its own
 * conversation store in "All chats", and what a new chat offers before any session.
 * The same flows against the real CLI: antigravity-real.spec.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { REPO } from '../lib/daemon.ts';
import { lastText, newChat, searchAll, send, shot, waitTurn } from '../lib/ui.ts';

const FAKE = join(REPO, 'e2e/fakes/fake-acp.mjs');
test.use({ daemonOptions: { env: { PHONECODE_ANTIGRAVITY_BIN: FAKE } } });

test('a plan is a document: its card and its link open it, and Proceed answers it', async ({ phone }) => {
  await newChat(phone, 'antigravity');
  await send(phone, 'write a plan to fix add');
  await waitTurn(phone, 1);
  const card = phone.testId('chat-item-document');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Fix add in math.js');
  await expect(card).toContainText('Fix the subtraction bug in add() and check the output.');
  await expect(card).toContainText('Waiting for your review');
  await shot(phone, 'agy-plan-card');

  await card.getByTestId('document-open').click();
  const sheet = phone.testId('document-sheet');
  await expect(sheet).toBeVisible();
  await expect(phone.testId('document-view').locator('h2')).toHaveText([
    'Proposed Changes',
    'Verification Plan',
  ]);
  await shot(phone, 'agy-plan-open');
  await phone.testId('document-close').click();
  await expect(sheet).toBeHidden();

  // The answer links to the file on the computer: the link opens the same document.
  const link = lastText(phone).locator('.doc-link');
  await expect(link).toHaveText('implementation_plan.md');
  await link.click();
  await expect(sheet).toHaveCount(1);
  await expect(sheet).toBeVisible();
  await phone.testId('document-close').click();
  await expect(sheet).toBeHidden();

  await card.getByTestId('document-proceed').click();
  await expect(phone.testId('chat-item-user').last()).toHaveText('Proceed');
  await waitTurn(phone, 2);
  await expect(phone.testId('document-proceed')).toHaveCount(0);
});

test('a document edited in place shows its whole text, once', async ({ phone }) => {
  await newChat(phone, 'antigravity');
  await send(phone, 'update the task list');
  await waitTurn(phone, 1);
  // Written, then edited: the latest version is the card in view.
  const card = phone.testId('chat-item-document');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Tasks');
  await card.getByTestId('document-open').click();
  const view = phone.testId('document-view');
  await expect(view).toContainText('Fix add');
  await expect(view).toContainText('Run main.js');
  await expect(view.locator('input[type="checkbox"]:checked')).toHaveCount(1);
  await phone.testId('document-close').click();
});

test("a command's output without Antigravity's report header, and its exit code", async ({ phone }) => {
  await newChat(phone, 'antigravity');
  await send(phone, 'list files');
  await waitTurn(phone, 1);
  const tool = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]');
  await tool.locator('.tool-head').click();
  const out = tool.locator('.tool-output');
  await expect(out).toHaveText(/^README\.md\nsrc\n?$/);
  await expect(tool).not.toContainText('Created At');
  await expect(tool).not.toContainText('Command output');
});

test('a sub-agent: named by its role above the composer and in the chat, its steps inside it', async ({
  phone,
}) => {
  await newChat(phone, 'antigravity');
  await send(phone, 'delegate the file listing');
  // At work: its role names it, with what it runs now.
  const chip = phone.testId('running-chip');
  await expect(chip).toContainText('Source Code Explorer (research)');
  await expect(phone.testId('running-steps')).toHaveText(
    /^Running ls src · 1 step$|^Running head -3 src\/math\.js · 2 steps$/,
  );
  const card = phone.testId('transcript').getByTestId('chat-item-task');
  await expect(card).toHaveAttribute('data-status', 'running');
  await shot(phone, 'agy-subagent-running');
  await chip.click();
  const sheet = phone.testId('watch-sheet');
  await expect(sheet.locator('h2')).toHaveText('Source Code Explorer (research)');
  await expect(sheet).toContainText('List the files in src and say what each does.');
  await expect(sheet.locator('[data-testid="chat-item-tool"][data-tool="Bash"]')).toHaveCount(2, {
    timeout: 10_000,
  });
  await sheet.getByTestId('watch-close').click();
  await expect(sheet).toBeHidden();
  await waitTurn(phone, 1);
  // Done: its two steps are in its card, none in the main thread.
  await expect(card).toHaveAttribute('data-status', 'done');
  await expect(card.getByTestId('task-status')).toHaveText('Done · 2 steps');
  await expect(phone.testId('running-strip')).toHaveCount(0);
  await expect(phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]')).toHaveCount(0);
  await expect(lastText(phone)).toContainText('The subagent found main.js and math.js.');
  await shot(phone, 'agy-subagent-done');
});

test('"All chats" searches the text of Antigravity\'s own conversations', async ({ phone, daemon }) => {
  // A conversation started at the computer: only Antigravity's own files have it.
  const id = '7f4c2a10-0000-4000-8000-000000000001';
  const logs = join(daemon.userHome, '.gemini/antigravity-cli/brain', id, '.system_generated/logs');
  mkdirSync(logs, { recursive: true });
  const lines = [
    {
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      created_at: '2026-11-27T20:00:00Z',
      content:
        '<USER_REQUEST>\nWhy does the capybara importer drop rows?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n</ADDITIONAL_METADATA>',
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      created_at: '2026-11-27T20:00:05Z',
      content: 'The importer skips rows whose date has a timezone; the narwhal parser rejects them.',
    },
  ];
  writeFileSync(join(logs, 'transcript.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  // Found by a word of the request and by a word of the answer, under its request as title.
  for (const word of ['capybara', 'narwhal']) {
    const rows = await searchAll(phone, word);
    const hit = rows.filter({ hasText: 'Why does the capybara importer drop rows?' });
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute('data-agent', 'antigravity');
    await phone.testId('search-cancel').click();
  }
});

test('a new chat offers the commands and models of earlier sessions, even before the first chat here', async ({
  phone,
  daemon,
}) => {
  // After a session: its slash commands are offered before the next chat has one.
  await newChat(phone, 'antigravity');
  await phone.testId('composer-slash').click();
  const palette = phone.testId('slash-palette');
  await expect(palette.getByTestId('slash-item').filter({ hasText: 'review' })).toHaveCount(1);
  await phone.page.keyboard.press('Escape');

  // Nothing remembered (a first run of phone-code), but past Antigravity sessions on the
  // computer: one is reopened in the background to learn what a new chat can pick.
  rmSync(join(daemon.home, 'acp-options.json'), { force: true });
  phone.allowConsole(/WebSocket connection to .* failed/);
  await daemon.restart();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  await expect(async () => {
    await phone.page.reload();
    await newChat(phone, 'antigravity');
    await expect(phone.testId('composer-model')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await phone.testId('composer-model').click();
  await expect(phone.testId('model-menu').getByTestId('model-fake-flash')).toBeVisible();
});
