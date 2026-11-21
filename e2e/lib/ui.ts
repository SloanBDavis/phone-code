/** UI steps shared by the specs, written the way a user moves through the app. */
import { expect, type Locator } from '@playwright/test';
import type { Phone } from './fixtures.ts';

/** `claude`, `codex`, `terminal` or an ACP agent id such as `gemini`. */
export type Kind = string;

interface ChatOptions {
  /** Folder relative to HOME (default the test project). */
  folder?: string;
  /** Model and permission mode, by their menu labels. */
  model?: string;
  mode?: string;
}

/** On a phone the sidebar is a drawer: open it (no-op on wide screens or when already open). */
export async function openSidebar(phone: Phone): Promise<void> {
  const shell = phone.testId('shell');
  if ((await shell.getAttribute('class'))?.includes('wide')) return;
  if ((await shell.getAttribute('data-drawer')) === 'open') return;
  await phone.testId('open-sidebar').click();
  await expect(shell).toHaveAttribute('data-drawer', 'open');
}

export async function closeSidebar(phone: Phone): Promise<void> {
  const shell = phone.testId('shell');
  if ((await shell.getAttribute('data-drawer')) !== 'open') return;
  await phone.page.keyboard.press('Escape');
  await expect(shell).toHaveAttribute('data-drawer', 'closed');
}

/** Starts a new chat (from wherever the phone is) and waits for its empty composer. */
export async function startNewChat(phone: Phone): Promise<void> {
  const screen = phone.testId('screen-chat');
  if ((await screen.count()) > 0 && (await screen.getAttribute('data-draft')) === 'true') return;
  if (await phone.testId('new-chat').isVisible()) await phone.testId('new-chat').click();
  else {
    await openSidebar(phone);
    await phone.testId('sidebar-new-chat').click();
  }
  await expect(screen).toHaveAttribute('data-draft', 'true');
}

/** Picks the harness on the composer bar (`terminal` opens one right away). */
export async function pickHarness(phone: Phone, kind: Kind): Promise<void> {
  await phone.testId('composer-harness').click();
  await phone.testId('harness-menu').getByTestId(`harness-${kind}`).click();
  if (kind !== 'terminal')
    await expect(phone.testId('composer-harness')).toHaveAttribute('data-harness', kind);
}

/**
 * Sets up a new chat on the bar: harness, folder (picker, from the home
 * folder), model and mode. The session is created by the first `send`.
 */
export async function newChat(phone: Phone, kind: Kind, opts: ChatOptions = {}): Promise<void> {
  await startNewChat(phone);
  await pickHarness(phone, kind);
  await pickFolder(phone, opts.folder ?? 'project');
  if (opts.model !== undefined) {
    await phone.testId('composer-model').click();
    await phone.page.getByRole('menuitem', { name: opts.model }).click();
  }
  if (opts.mode !== undefined) {
    await phone.testId('composer-mode').click();
    await phone.page.getByRole('menuitem', { name: opts.mode }).click();
  }
}

/** A new chat with `kind` whose first message is `text`; returns the new session's id. */
export async function startChat(
  phone: Phone,
  kind: Kind,
  text: string,
  opts: ChatOptions = {},
): Promise<string> {
  await newChat(phone, kind, opts);
  await send(phone, text);
  return currentId(phone);
}

/** Opens a terminal in `folder` (Terminal on the harness picker) and returns its session id. */
export async function openTerminal(phone: Phone, opts: { folder?: string } = {}): Promise<string> {
  await startNewChat(phone);
  await pickFolder(phone, opts.folder ?? 'project');
  await pickHarness(phone, 'terminal');
  const screen = phone.testId('screen-terminal');
  await expect(screen).toBeVisible();
  const id = await screen.getAttribute('data-session-id');
  expect(id).toBeTruthy();
  return id ?? '';
}

/** The session the open chat shows, once it exists (after the first message). */
export async function currentId(phone: Phone): Promise<string> {
  const screen = phone.page.locator('[data-testid="screen-chat"], [data-testid="screen-terminal"]');
  await expect(screen).toHaveAttribute('data-session-id', /.+/);
  return (await screen.getAttribute('data-session-id')) ?? '';
}

/** In a new chat: choose `folder` (relative to HOME) with the folder picker. */
export async function pickFolder(phone: Phone, folder: string): Promise<void> {
  await phone.testId('composer-folder').click();
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
  await expect(phone.testId('composer-folder')).toContainText(name);
}

/** A chat's row in the sidebar (open the sidebar first on a phone). */
export function row(phone: Phone, sessionId: string): Locator {
  return phone.page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
}

/** Opens a chat from the sidebar. */
export async function openChat(phone: Phone, sessionId: string): Promise<void> {
  await openSidebar(phone);
  await row(phone, sessionId).click();
  await expect(phone.page.locator(`.main [data-session-id="${sessionId}"]`)).toBeVisible();
  await expect(phone.testId('shell')).not.toHaveAttribute('data-drawer', 'open');
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

/** Opens "This computer" (connection, harnesses, preferences) from the sidebar. */
export async function openComputer(phone: Phone): Promise<void> {
  await openSidebar(phone);
  await phone.testId('open-computer').click();
  await expect(phone.testId('computer-sheet')).toBeVisible();
}

export async function closeComputer(phone: Phone): Promise<void> {
  await phone.testId('computer-close').click();
  await expect(phone.testId('computer-sheet')).toBeHidden();
}

/** Where screenshots taken for visual review go (E2E_SHOTS, default the OS temp dir). */
export const SHOTS = `${process.env['E2E_SHOTS'] ?? `${process.env['TMPDIR'] ?? '/tmp'}/phonecode-shots`}/`;

/** Screenshot for visual review once the drawer and sheets have settled. */
export async function shot(phone: Phone, name: string): Promise<void> {
  await phone.page.waitForTimeout(450);
  await phone.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await phone.page.screenshot({ path: `${SHOTS}${name}.png` });
}

/** Searches "All chats" from the sidebar; returns the result rows. */
export async function searchAll(phone: Phone, text: string): Promise<Locator> {
  await openSidebar(phone);
  const input = phone.testId('search-input');
  await input.click();
  await input.fill(text);
  await expect(phone.testId('all-chats')).toBeVisible();
  return phone.testId('history-row');
}
