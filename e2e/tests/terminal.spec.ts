import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Phone } from '../lib/fixtures.ts';
import { openChat, openSidebar, openTerminal, shot, startNewChat } from '../lib/ui.ts';

/** Visible terminal text (xterm's DOM renderer, which the app uses on iOS). */
function screen(phone: Phone): ReturnType<Phone['page']['locator']> {
  return phone.testId('terminal').locator('.xterm-rows');
}

async function run(phone: Phone, command: string): Promise<void> {
  await phone.page.keyboard.type(command);
  await phone.page.keyboard.press('Enter');
}

async function term(phone: Phone, folder?: string): Promise<string> {
  const id = await openTerminal(phone, folder === undefined ? {} : { folder });
  await expect(screen(phone)).toContainText('$');
  await phone.testId('terminal').click();
  return id;
}

test('runs a command and shows its output', async ({ phone }) => {
  await term(phone);
  await run(phone, 'echo "answer=$((6*7))"');
  await expect(screen(phone)).toContainText('answer=42');
  await shot(phone, 'terminal');
});

test('key bar: ctrl-C, tab completion, history arrows, ctrl modifier', async ({ phone, daemon }) => {
  const folder = daemon.folder('term-keys');
  writeFileSync(join(daemon.userHome, folder, 'uniquely-named-file.txt'), 'file-body-xyz\n');
  await term(phone, folder);

  // ^C interrupts a long sleep: the next command runs right away.
  await run(phone, 'sleep 60');
  await phone.testId('key-ctrl-c').click();
  await run(phone, 'echo after-$((1+1))');
  await expect(screen(phone)).toContainText('after-2', { timeout: 5000 });

  // ctrl as a modifier + typed key, too.
  await run(phone, 'sleep 60');
  await phone.testId('key-ctrl').click();
  await expect(phone.testId('key-ctrl')).toHaveAttribute('aria-pressed', 'true');
  await phone.page.keyboard.type('c');
  await expect(phone.testId('key-ctrl')).toHaveAttribute('aria-pressed', 'false');
  await run(phone, 'echo again-$((2+1))');
  await expect(screen(phone)).toContainText('again-3', { timeout: 5000 });

  // Tab completes a file name.
  await phone.page.keyboard.type('cat uniquely');
  await phone.testId('key-tab').click();
  await expect(screen(phone)).toContainText('cat uniquely-named-file.txt');
  await phone.page.keyboard.press('Enter');
  await expect(screen(phone)).toContainText('file-body-xyz');

  // Up recalls the previous command.
  await run(phone, 'clear');
  await expect(screen(phone)).not.toContainText('file-body-xyz');
  await phone.testId('key-up').click();
  await phone.testId('key-up').click();
  await expect(screen(phone)).toContainText('cat uniquely-named-file.txt');
  await phone.page.keyboard.press('Enter');
  await expect(screen(phone)).toContainText('file-body-xyz');
});

test('resizes the PTY when the viewport changes', async ({ phone }) => {
  await term(phone);
  await run(phone, 'echo "size=$(tput cols)x$(tput lines)"');
  await expect(screen(phone)).toContainText(/size=\d+x\d+/);
  const portrait = /size=(\d+)x(\d+)/.exec(await screen(phone).innerText());
  // Rotate to landscape.
  await phone.page.setViewportSize({ width: 852, height: 393 });
  await run(phone, 'clear; echo "wide=$(tput cols)x$(tput lines)"');
  await expect(screen(phone)).toContainText(/wide=\d+x\d+/);
  const landscape = /wide=(\d+)x(\d+)/.exec(await screen(phone).innerText());
  expect(Number(landscape?.[1])).toBeGreaterThan(Number(portrait?.[1]));
  expect(Number(landscape?.[2])).toBeLessThan(Number(portrait?.[2]));
  // The app fills the landscape screen (no desktop-style framed card on a phone).
  expect((await phone.page.locator('.app').boundingBox())?.width).toBe(852);
  await shot(phone, 'terminal-landscape');
});

test('a full-screen app survives leaving and re-entering the screen', async ({ phone, daemon }) => {
  const folder = daemon.folder('term-less');
  writeFileSync(
    join(daemon.userHome, folder, 'long.txt'),
    Array.from({ length: 300 }, (_, i) => `line number ${i + 1}`).join('\n'),
  );
  const id = await term(phone, folder);
  await run(phone, 'less long.txt');
  await expect(screen(phone)).toContainText('line number 1');
  await phone.page.keyboard.press('Space');
  await expect(screen(phone)).not.toContainText(/line number 1(?!\d)/);
  const shown = /line number (\d+)/.exec(await screen(phone).innerText())?.[1] ?? '';
  expect(Number(shown)).toBeGreaterThan(5);
  // Away to a new chat and back through the sidebar.
  await startNewChat(phone);
  await openChat(phone, id);
  await expect(phone.testId('screen-terminal')).toBeVisible();
  // The same page of less is back on screen.
  await expect(screen(phone)).toContainText(`line number ${shown}`);
  await phone.testId('terminal').click();
  await phone.page.keyboard.press('q');
  await run(phone, 'echo quit-ok');
  await expect(screen(phone)).toContainText('quit-ok');
});

test('large output does not freeze the UI', async ({ phone }) => {
  await term(phone);
  await run(phone, 'seq 1 300000; echo seq-finished');
  await expect(screen(phone)).toContainText('seq-finished', { timeout: 20_000 });
  // Still responsive: navigation and input work right after.
  const t0 = Date.now();
  await openSidebar(phone);
  expect(Date.now() - t0).toBeLessThan(5000);
});
