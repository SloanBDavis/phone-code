/**
 * Antigravity for real: the signed-in `agy` on this computer, real model turns. Skipped
 * unless PHONECODE_REAL_AGY=1 (it needs `agy` installed and signed in, and spends quota):
 *
 *   PHONECODE_REAL_AGY=1 bunx playwright test tests/antigravity-real.spec.ts
 *
 * agy runs with the real HOME (where its sign-in and conversations are), through a small
 * wrapper; the daemon and everything else keep the test's own HOME.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Phone } from '../lib/fixtures.ts';
import { lastText, newChat, searchAll, send, shot, waitTurn } from '../lib/ui.ts';

const REAL = process.env['PHONECODE_REAL_AGY'] === '1';
const AGY = [join(homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'].find(
  existsSync,
);
const WRAPPER = join(tmpdir(), 'phonecode-real-agy.sh');
if (REAL && AGY) {
  writeFileSync(WRAPPER, `#!/bin/sh\nHOME=${JSON.stringify(homedir())} exec ${JSON.stringify(AGY)} "$@"\n`);
  chmodSync(WRAPPER, 0o755);
}

test.skip(!REAL || !AGY, 'set PHONECODE_REAL_AGY=1 with agy installed and signed in');
test.use({ daemonOptions: { env: { PHONECODE_ANTIGRAVITY_BIN: WRAPPER } } });
test.setTimeout(300_000);

/** Allows whatever the agent asks until turn `n` has ended. */
async function approveUntilTurn(phone: Phone, n: number): Promise<void> {
  const pending = phone.page.locator('[data-testid="chat-item-permission"][data-status="pending"]');
  const turns = phone.testId('chat-item-turn');
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- one step at a time, as a person would
    if ((await turns.count()) >= n) return;
    // oxlint-disable-next-line no-await-in-loop
    if ((await pending.count()) > 0) await pending.first().getByTestId('permission-allow').click();
    // oxlint-disable-next-line no-await-in-loop
    else await phone.page.waitForTimeout(500);
  }
  throw new Error(`turn ${n} did not end`);
}

test('a real turn: an edit and a command, each approved, then the answer', async ({ phone, daemon }) => {
  await newChat(phone, 'antigravity');
  await shot(phone, 'agy-real-new-chat');
  await send(
    phone,
    'Create a file hello.txt containing the word hi, then run ls -la and tell me in one line what you see.',
  );
  // Answered cards fold into the turn's steps: the one to answer is the pending one.
  const pending = phone.page.locator('[data-testid="chat-item-permission"][data-status="pending"]');
  for (let i = 0; i < 2; i++) {
    await expect(pending).toHaveCount(1, { timeout: 120_000 });
    await shot(phone, `agy-real-permission-${i}`);
    await pending.getByTestId('permission-allow').click();
    await expect(pending).toHaveCount(0);
  }
  await expect(phone.testId('chat-item-turn')).toHaveCount(1, { timeout: 180_000 });
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false');
  expect(readFileSync(join(daemon.project, 'hello.txt'), 'utf8').trim()).toBe('hi');
  await shot(phone, 'agy-real-turn');
  // The command's output, without the report header agy wraps it in.
  const cmd = phone.page.locator('[data-testid="chat-item-tool"][data-tool="Bash"]').first();
  await cmd.locator('.tool-head').click();
  await expect(cmd.locator('.tool-output')).toContainText('hello.txt');
  await expect(cmd).not.toContainText('Created At');
  await shot(phone, 'agy-real-command');
});

test('its modes, models and thinking levels are on the bar', async ({ phone }) => {
  await newChat(phone, 'antigravity');
  await phone.testId('composer-mode').click();
  const modes = phone.testId('mode-menu');
  for (const m of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    await expect(modes.getByTestId(`mode-${m}`)).toBeVisible();
  await phone.page.keyboard.press('Escape');
  await phone.testId('composer-model').click();
  await expect(phone.testId('model-menu').getByRole('menuitem')).not.toHaveCount(0);
  await shot(phone, 'agy-real-models');
  await phone.page.keyboard.press('Escape');
  await phone.testId('composer-slash').click();
  await expect(
    phone.testId('slash-palette').getByTestId('slash-item').filter({ hasText: 'goal' }),
  ).toHaveCount(1);
  await phone.page.keyboard.press('Escape');
});

test('plan mode: a plan to review, opened on the phone, then Proceed carries it out', async ({
  phone,
  daemon,
}) => {
  mkdirSync(join(daemon.project, 'src'), { recursive: true });
  writeFileSync(
    join(daemon.project, 'src/math.js'),
    'export function add(a, b) {\n  return a - b; // bug\n}\n',
  );
  writeFileSync(
    join(daemon.project, 'src/main.js'),
    "import { add } from './math.js';\nconsole.log(add(2, 3));\n",
  );
  await newChat(phone, 'antigravity', { mode: 'Plan only' });
  await send(phone, 'Find the bug in add in src/math.js and make a short plan to fix it. Keep it brief.');
  await approveUntilTurn(phone, 1);
  const card = phone.testId('chat-item-document');
  await expect(card.last()).toBeVisible();
  await shot(phone, 'agy-real-plan');
  await card.last().getByTestId('document-open').click();
  await expect(phone.testId('document-view')).toContainText(/add/);
  await shot(phone, 'agy-real-plan-open');
  await phone.testId('document-close').click();
  await expect(phone.testId('document-proceed')).toBeVisible();
  await phone.testId('document-proceed').click();
  await approveUntilTurn(phone, 2);
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false');
  expect(readFileSync(join(daemon.project, 'src/math.js'), 'utf8')).toContain('a + b');
  await shot(phone, 'agy-real-proceeded');
});

test('"All chats" finds these conversations in Antigravity\'s own store', async ({ phone }) => {
  const rows = await searchAll(phone, 'math.js');
  await expect(
    rows
      .filter({ has: phone.page.locator('[data-agent="antigravity"]') })
      .or(phone.page.locator('[data-testid="history-row"][data-agent="antigravity"]'))
      .first(),
  ).toBeVisible({ timeout: 20_000 });
});
