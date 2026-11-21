/** UI steps shared by the specs, written the way a user moves through the app. */
import { expect, type Locator } from '@playwright/test';
import type { Phone } from './fixtures.ts';

export type Kind = 'claude' | 'codex' | 'terminal';

/**
 * Opens the new-session sheet, picks `kind`, navigates the folder picker from
 * the home folder into `folder` (a path relative to HOME, default the test
 * project), starts the session and waits for its screen. Returns the session id.
 */
export async function createSession(
  phone: Phone,
  kind: Kind,
  opts: { folder?: string; model?: string; mode?: string } = {},
): Promise<string> {
  const { page } = phone;
  await phone.testId('new-session').click();
  const sheet = phone.testId('new-session-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId(`new-kind-${kind}`).click();
  await expect(sheet.getByTestId(`new-kind-${kind}`)).toHaveAttribute('aria-pressed', 'true');
  await pickFolder(phone, opts.folder ?? 'project');
  if (opts.model !== undefined) {
    await sheet.getByTestId('new-model').click();
    await page.getByRole('menuitem', { name: opts.model }).click();
  }
  if (opts.mode !== undefined) {
    await sheet.getByTestId('new-permission').click();
    await page.getByRole('menuitem', { name: opts.mode }).click();
  }
  await sheet.getByTestId('new-start').click();
  await expect(sheet).toBeHidden();
  const screen = kind === 'terminal' ? phone.testId('screen-terminal') : phone.testId('screen-chat');
  await expect(screen).toBeVisible();
  const id = await screen.getAttribute('data-session-id');
  expect(id).toBeTruthy();
  return id ?? '';
}

/** In the open new-session sheet: choose `folder` (relative to HOME) with the folder picker. */
export async function pickFolder(phone: Phone, folder: string): Promise<void> {
  const sheet = phone.testId('new-session-sheet');
  await sheet.getByTestId('new-folder').click();
  const picker = phone.testId('folder-picker');
  await expect(picker).toBeVisible();
  // Start from the home folder: walk up until the crumb shows "~".
  const crumb = picker.locator('.crumb');
  while ((await crumb.innerText()).trim() !== '~') {
    const before = await crumb.innerText();
    if (!before.startsWith('~')) break;
    await picker.getByTestId('folder-up').click();
    await expect(crumb).not.toHaveText(before);
  }
  for (const part of folder.split('/').filter(Boolean)) {
    const before = await crumb.innerText();
    await picker
      .getByTestId('folder-entry')
      .filter({ hasText: new RegExp(`^${part}$`) })
      .click();
    await expect(crumb).not.toHaveText(before);
  }
  await picker.getByTestId('folder-choose').click();
  await expect(picker).toBeHidden();
  const name = folder.split('/').findLast((p) => p !== '') ?? '~';
  await expect(sheet.getByTestId('new-folder')).toContainText(name);
}

export function row(phone: Phone, sessionId: string): Locator {
  return phone.page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
}

/** Types a message in the composer and sends it. */
export async function send(phone: Phone, text: string): Promise<void> {
  const input = phone.testId('composer-input');
  await input.fill(text);
  await phone.testId('composer-send').click();
  await expect(input).toHaveValue('');
}

/** Waits until the agent's turn ends (a turn footer appears beyond `count` existing ones). */
export async function waitTurn(phone: Phone, count: number, outcome = 'completed'): Promise<void> {
  const turns = phone.testId('chat-item-turn');
  await expect(turns).toHaveCount(count, { timeout: 20_000 });
  await expect(turns.nth(count - 1)).toHaveAttribute('data-outcome', outcome);
}

export function lastText(phone: Phone): Locator {
  return phone.testId('chat-item-text').last();
}

/** Back to the sessions list. */
export async function back(phone: Phone): Promise<void> {
  await phone.testId('nav-back').click();
  await expect(phone.testId('screen-sessions')).toBeVisible();
}

/** Where screenshots taken for visual review go (E2E_SHOTS, default the OS temp dir). */
export const SHOTS = `${process.env['E2E_SHOTS'] ?? `${process.env['TMPDIR'] ?? '/tmp'}/phonecode-shots`}/`;

/** Screenshot for visual review once screen transitions have settled. */
export async function shot(phone: Phone, name: string): Promise<void> {
  await expect(phone.page.locator('.screen-host.moving')).toHaveCount(0);
  await phone.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await phone.page.screenshot({ path: `${SHOTS}${name}.png` });
}
