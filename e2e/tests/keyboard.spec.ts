/**
 * The app from the keyboard alone, on a desktop-sized window (the Mac app's, or a
 * browser's): the shortcuts (screens/shortcuts.tsx), lists, menus, dialogs and the
 * approval and question cards.
 */
import { expect, test, type Phone } from '../lib/fixtures.ts';
import { closeSidebar, currentId, newChat, send, shot, waitTurn } from '../lib/ui.ts';

/** The command key the page expects: ⌘ on Apple platforms, Ctrl elsewhere. */
async function mod(phone: Phone): Promise<string> {
  const mac = await phone.page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent),
  );
  return mac ? 'Meta' : 'Control';
}

async function desktop(phone: Phone): Promise<void> {
  await phone.page.setViewportSize({ width: 1280, height: 820 });
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  await expect(phone.testId('shell')).toHaveClass(/\bwide\b/);
}

const focusedTestId = (phone: Phone): Promise<string | null> =>
  phone.page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

test('the shortcuts list opens with ⌘/, and Escape closes it and gives focus back', async ({ phone }) => {
  await desktop(phone);
  const m = await mod(phone);
  await phone.testId('composer-input').focus();
  await phone.page.keyboard.press(`${m}+Slash`);
  const sheet = phone.testId('shortcuts-sheet');
  await expect(sheet).toBeVisible();
  for (const g of ['General', 'Chats', 'In a chat', 'Tiles', 'Approvals and questions', 'Lists and menus'])
    await expect(phone.testId('shortcuts-list').getByRole('heading', { name: g })).toBeVisible();
  await expect(phone.testId('shortcuts-list')).toContainText('Rename the chat');
  await shot(phone, 'keyboard-shortcuts');
  // Tab stays inside the sheet.
  for (let i = 0; i < 4; i++) await phone.page.keyboard.press('Tab');
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await phone.page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(await focusedTestId(phone)).toBe('composer-input');
});

test('chats from the keyboard: the list, switching, renaming, archiving and deleting', async ({ phone }) => {
  await desktop(phone);
  const m = await mod(phone);
  await newChat(phone, 'claude');
  await send(phone, 'hello first');
  await waitTurn(phone, 1);
  const first = await currentId(phone);
  await newChat(phone, 'claude');
  await send(phone, 'hello second');
  await waitTurn(phone, 1);
  const second = await currentId(phone);

  // ⌘K: the search field; ↓ into the list, ↓ to the next row, ⏎ opens it.
  await phone.page.keyboard.press(`${m}+k`);
  expect(await focusedTestId(phone)).toBe('search-input');
  await phone.page.keyboard.press('Escape');
  await phone.testId('search-input').focus();
  await phone.page.keyboard.press('ArrowDown');
  expect(await phone.page.evaluate(() => document.activeElement?.getAttribute('data-session-id'))).toBe(
    second,
  );
  await phone.page.keyboard.press('ArrowDown');
  expect(await phone.page.evaluate(() => document.activeElement?.getAttribute('data-session-id'))).toBe(
    first,
  );
  await phone.page.keyboard.press('Enter');
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', first);

  // ⌥↑ ⌥↓: the chat above and below; ⌘1: the first in the list.
  await phone.page.keyboard.press('Alt+ArrowUp');
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', second);
  await phone.page.keyboard.press('Alt+ArrowDown');
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', first);
  await phone.page.keyboard.press(`${m}+1`);
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', second);

  // ⌘⇧R renames the chat: the field has focus, ⏎ saves.
  await phone.page.keyboard.press(`${m}+Shift+r`);
  const input = phone.testId('rename-dialog-input');
  await expect(input).toBeFocused();
  await input.fill('Renamed by keyboard');
  await phone.page.keyboard.press('Enter');
  await expect(phone.testId('chat-title')).toContainText('Renamed by keyboard');
  // F2 on a row renames that chat; Escape cancels and changes nothing.
  await phone.page.locator(`[data-testid="session-row"][data-session-id="${first}"]`).focus();
  await phone.page.keyboard.press('F2');
  await expect(input).toBeFocused();
  await phone.page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  await expect(phone.page.locator(`[data-testid="session-row"][data-session-id="${first}"]`)).toContainText(
    'hello first',
  );

  // ⌘⌫ asks first, with Cancel focused: Return keeps the chat.
  await phone.testId('composer-input').focus();
  await phone.page.keyboard.press('Escape');
  await phone.page.keyboard.press(`${m}+Backspace`);
  await expect(phone.testId('delete-dialog')).toBeVisible();
  await phone.page.keyboard.press('Enter');
  await expect(phone.testId('delete-dialog')).toBeHidden();
  await expect(phone.page.locator(`[data-testid="session-row"][data-session-id="${second}"]`)).toHaveCount(1);
  // ⌘⇧A archives it.
  await phone.page.keyboard.press(`${m}+Shift+a`);
  await expect(phone.page.locator(`[data-testid="session-row"][data-session-id="${second}"]`)).toHaveCount(0);
});

test("menus from the keyboard: the bar's pickers open with ⌥⌘1–5, arrows move, Return chooses", async ({
  phone,
}) => {
  await desktop(phone);
  const m = await mod(phone);
  await newChat(phone, 'claude');
  await phone.testId('composer-input').focus();
  // ⌥⌘4: permissions. The checked mode has focus; ↓ moves, ⏎ chooses, focus is back on the chip.
  await phone.page.keyboard.press(`Alt+${m}+Digit4`);
  const menu = phone.testId('mode-menu');
  await expect(menu).toBeVisible();
  await expect(phone.testId('mode-default')).toBeFocused();
  await phone.page.keyboard.press('ArrowDown');
  await expect(phone.testId('mode-acceptEdits')).toBeFocused();
  await phone.page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(phone.testId('composer-mode')).toHaveText(/Edits/);
  // Back where the shortcut was pressed: in the message box, to keep typing.
  await expect(phone.testId('composer-input')).toBeFocused();
  // Escape closes a menu and nothing else.
  await phone.page.keyboard.press(`Alt+${m}+Digit1`);
  await expect(phone.testId('harness-menu')).toBeVisible();
  await phone.page.keyboard.press('Escape');
  await expect(phone.testId('harness-menu')).toBeHidden();
  await expect(phone.testId('screen-chat')).toBeVisible();
});

test('approvals and questions by number; ⌘. stops the agent', async ({ phone }) => {
  await desktop(phone);
  const m = await mod(phone);
  await newChat(phone, 'claude');
  await send(phone, 'please run tests');
  const perm = phone.page.locator('[data-testid="chat-item-permission"][data-status="pending"]');
  await expect(perm).toHaveCount(1);
  // The buttons show their number where there is a keyboard.
  await expect(perm.getByTestId('permission-allow').locator('.kbd-hint')).toHaveText('1');
  await shot(phone, 'keyboard-approval');
  // In the message box a digit is text; Escape leaves it, then 1 allows.
  await phone.testId('composer-input').focus();
  await phone.page.keyboard.press('1');
  await expect(phone.testId('composer-input')).toHaveValue('1');
  await phone.testId('composer-input').fill('');
  await phone.page.keyboard.press('Escape');
  await phone.page.keyboard.press('1');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-item-permission').first()).toHaveAttribute('data-status', 'allowed');

  await send(phone, 'ask me something');
  const q = phone.page.locator('[data-testid="chat-item-question"][data-status="pending"]');
  await expect(q).toHaveCount(1);
  await phone.page.keyboard.press('Escape');
  await phone.page.keyboard.press('2');
  await expect(q.getByTestId('question-option').nth(1)).toHaveAttribute('aria-checked', 'true');
  await q.getByTestId('question-submit').focus();
  await phone.page.keyboard.press('Enter');
  await expect(q).toHaveCount(0);
  await waitTurn(phone, 2);

  await send(phone, 'give me a long answer');
  await expect(phone.testId('composer-stop')).toBeVisible();
  await phone.page.keyboard.press(`${m}+Period`);
  await waitTurn(phone, 3, 'interrupted');
});

test('⌘B puts the chats away and back; ⌘D opens a tile beside, ⌥⌘← → move between tiles', async ({
  phone,
}) => {
  await desktop(phone);
  const m = await mod(phone);
  await closeSidebar(phone);
  await phone.testId('composer-input').focus();
  await phone.page.keyboard.press(`${m}+b`);
  await expect(phone.testId('sidebar')).toBeHidden();
  await expect(phone.testId('show-sidebar')).toBeVisible();
  expect((await phone.page.locator('.main').boundingBox())?.x).toBe(0);
  await shot(phone, 'keyboard-sidebar-hidden');
  await phone.page.keyboard.press(`${m}+b`);
  await expect(phone.testId('sidebar')).toBeVisible();
  await expect(phone.testId('show-sidebar')).toHaveCount(0);

  // A chat in this tile first: a new chat beside a new chat is the same one.
  await send(phone, 'hello tiles');
  await waitTurn(phone, 1);
  await phone.testId('composer-input').focus();
  await phone.page.keyboard.press(`${m}+d`);
  const panes = phone.testId('pane');
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveAttribute('data-focused', 'true');
  await phone.page.keyboard.press(`Alt+${m}+ArrowLeft`);
  await expect(panes.nth(0)).toHaveAttribute('data-focused', 'true');
  await expect(panes.nth(0).getByTestId('composer-input')).toBeFocused();
  await phone.page.keyboard.press(`Alt+${m}+ArrowRight`);
  await expect(panes.nth(1)).toHaveAttribute('data-focused', 'true');
  await phone.page.keyboard.press(`Alt+${m}+w`);
  await expect(panes).toHaveCount(1);
});
