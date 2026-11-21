/** The sidebar of chats, new chats from the composer bar, archive, rename and delete. */
import type { Locator } from '@playwright/test';
import { expect, test, type Phone } from '../lib/fixtures.ts';
import {
  currentId,
  lastText,
  newChat,
  openChat,
  openSidebar,
  openTerminal,
  pickHarness,
  row,
  searchAll,
  send,
  shot,
  startChat,
  startNewChat,
  waitTurn,
} from '../lib/ui.ts';

/** A session row with its swipe action. */
function swipeRow(phone: Phone, sessionId: string): Locator {
  return phone.page.locator('.swipe', { has: row(phone, sessionId) });
}

/** Swipe a session row left with a real touch gesture: `full` runs Archive, otherwise it reveals it. */
async function swipe(phone: Phone, sessionId: string, full = false): Promise<void> {
  const box = await row(phone, sessionId).boundingBox();
  if (box === null) throw new Error('row not visible');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width - 20;
  const cdp = await phone.context.newCDPSession(phone.page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number): Promise<unknown> =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const dist = full ? box.width * 0.85 : 140;
  await touch('touchStart', x0);
  for (let i = 1; i <= 10; i++) await touch('touchMove', x0 - (dist * i) / 10);
  await touch('touchEnd', x0 - dist);
  await cdp.detach();
  if (!full) await expect(swipeRow(phone, sessionId)).toHaveAttribute('data-open', 'true');
}

test('the first message creates the chat with the bar’s harness, model, mode and folder', async ({
  phone,
}) => {
  // Launch: a ready new chat, nothing to set up.
  await expect(phone.testId('composer-harness')).toHaveAttribute('data-harness', 'claude');
  await shot(phone, 'new-chat');
  // Terminal on the picker opens one right away, in the chosen folder.
  const term = await openTerminal(phone, { folder: 'other' });
  await newChat(phone, 'claude', { mode: 'Plan only' });
  await expect(phone.testId('composer-mode')).toHaveText(/Plan/);
  await send(phone, 'hello');
  // One gesture: the bubble at once, then the session, without leaving the screen.
  const claude = await currentId(phone);
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'false');
  await expect(phone.testId('chat-item-user')).toHaveText('hello');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-title')).toContainText('project');
  await expect(phone.testId('composer-mode')).toHaveText(/Plan/);

  const codex = await startChat(phone, 'codex', 'hello codex', { folder: 'project/src' });
  await expect(phone.testId('chat-title')).toContainText('src');

  await openSidebar(phone);
  for (const id of [claude, codex, term]) await expect(row(phone, id)).toBeVisible();
  await expect(row(phone, codex)).toHaveAttribute('data-agent', 'codex');
  await shot(phone, 'sidebar');

  // Choices are remembered per harness: the next new chat starts where the last one did.
  await phone.testId('sidebar-new-chat').click();
  await expect(phone.testId('composer-harness')).toHaveAttribute('data-harness', 'codex');
  await expect(phone.testId('composer-folder')).toContainText('src');
  await pickHarness(phone, 'claude');
  await expect(phone.testId('composer-folder')).toContainText('project');
  await expect(phone.testId('composer-mode')).toHaveText(/Plan/);
  // Recent folders are one tap away.
  await phone.testId('composer-folder').click();
  await expect(phone.testId('folder-recent')).not.toHaveCount(0);
  await phone.testId('folder-close').click();
  await expect(phone.testId('folder-picker')).toBeHidden();
});

test('changing harness in a chat starts a new chat; model and mode change in place', async ({ phone }) => {
  const id = await startChat(phone, 'claude', 'hello');
  await waitTurn(phone, 1);
  await phone.testId('composer-mode').click();
  await phone.testId('mode-menu').getByTestId('mode-acceptEdits').click();
  await expect(phone.testId('composer-mode')).toHaveText(/Edits/);
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', id);
  await phone.testId('composer-input').fill('carry me over');
  await pickHarness(phone, 'codex');
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'true');
  await expect(phone.testId('composer-input')).toHaveValue('carry me over');
  // The old chat is unchanged.
  await openChat(phone, id);
  await expect(phone.testId('composer-harness')).toHaveAttribute('data-harness', 'claude');
});

test('rename and delete from the long-press menu', async ({ phone }) => {
  const id = await openTerminal(phone);
  await openSidebar(phone);
  await row(phone, id).click({ button: 'right' });
  await phone.testId('row-menu').getByTestId('menu-rename').click();
  await phone.testId('rename-dialog-input').fill('My build shell');
  await phone.testId('rename-dialog-confirm').click();
  await expect(row(phone, id)).toContainText('My build shell');
  // Survives a reload (it is the daemon's state, not the page's).
  await phone.page.reload();
  await openSidebar(phone);
  await expect(row(phone, id)).toContainText('My build shell');

  await row(phone, id).click({ button: 'right' });
  await phone.testId('row-menu').getByTestId('menu-delete').click();
  await expect(phone.testId('delete-dialog')).toContainText('My build shell');
  await phone.testId('delete-dialog-confirm').click();
  await expect(row(phone, id)).toHaveCount(0);
  await phone.page.reload();
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveCount(0);
});

test('rename and delete from the chat menu', async ({ phone }) => {
  const id = await startChat(phone, 'claude', 'hello');
  await waitTurn(phone, 1);
  await phone.testId('chat-title').click();
  await phone.testId('menu-rename').click();
  await phone.testId('rename-dialog-input').fill('Renamed chat');
  await phone.testId('rename-dialog-confirm').click();
  await expect(phone.testId('chat-title')).toContainText('Renamed chat');
  // A manual title stays.
  await send(phone, 'hello again');
  await waitTurn(phone, 2);
  await expect(phone.testId('chat-title')).toContainText('Renamed chat');
  await phone.testId('chat-title').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog-confirm').click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'true');
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveCount(0);
});

test('archive: swipe, undo, every phone, and back through All chats', async ({ phone, newPhone }) => {
  const id = await startChat(phone, 'claude', 'hello, remember the word heron');
  await waitTurn(phone, 1);
  await openSidebar(phone);

  // Reveal and tap Archive; Undo brings it back.
  await swipe(phone, id);
  await swipeRow(phone, id).getByTestId('session-archive').click();
  await expect(row(phone, id)).toHaveCount(0);
  await shot(phone, 'archive-undo');
  await phone.testId('toast-undo').click();
  await expect(row(phone, id)).toBeVisible();

  // A full swipe archives at once; the other phone's sidebar follows.
  await swipe(phone, id, true);
  await expect(row(phone, id)).toHaveCount(0);
  const other = await newPhone();
  await other.pair();
  await openSidebar(other);
  // Once its list has loaded, the archived chat is not in it.
  await expect(other.page.locator('[data-testid="sidebar-list"] .spinner')).toHaveCount(0);
  await expect(row(other, id)).toHaveCount(0);
  // Still on the host: reload agrees.
  await phone.page.reload();
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveCount(0);

  // "All chats" finds it, marked; opening it puts it back in every sidebar.
  const hit = (await searchAll(other, 'heron')).filter({ hasText: 'heron' }).first();
  await expect(hit).toHaveAttribute('data-archived', 'true');
  await hit.click();
  await expect(other.testId('screen-chat')).toHaveAttribute('data-session-id', id);
  await expect(other.testId('chat-item-user').first()).toContainText('heron');
  await expect(row(phone, id)).toBeVisible();
  await openSidebar(other);
  await expect(row(other, id)).toBeVisible();
});

test('All chats: search as you type, snippets, filter by harness', async ({ phone }) => {
  const a = await startChat(phone, 'claude', 'please look at the flamingo parser');
  await waitTurn(phone, 1);
  await startChat(phone, 'codex', 'and the flamingo lexer');
  await waitTurn(phone, 1);
  await openSidebar(phone);
  await phone.testId('search-input').click();
  // Before typing: recent conversations.
  await expect(phone.testId('history-row').first()).toBeVisible();
  const rows = await searchAll(phone, 'flamingo');
  await expect(rows).toHaveCount(2);
  await shot(phone, 'all-chats');
  await phone.testId('history-filter-codex').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-agent', 'codex');
  await phone.testId('history-filter-all').click();
  await expect(rows).toHaveCount(2);
  await phone.testId('search-input').fill('nothing-matches-this-zz');
  await expect(phone.testId('history-empty')).toBeVisible();
  await phone.testId('search-input').fill('flamingo parser');
  await rows.filter({ hasText: 'flamingo' }).first().click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', a);
  await expect(lastText(phone)).not.toHaveText('');
});

test('status and unread change live in the sidebar', async ({ phone }) => {
  const id = await startChat(phone, 'claude', 'run tests');
  await expect(phone.testId('chat-item-permission')).toHaveAttribute('data-status', 'pending');
  await openSidebar(phone);
  // Waiting for approval: "Needs you".
  const waiting = phone.testId('section-waiting');
  await expect(waiting.locator(`[data-session-id="${id}"]`)).toHaveAttribute('data-status', 'waiting');
  await expect(row(phone, id).locator('.pill-attention')).toHaveText('Approval');
  await shot(phone, 'sidebar-waiting');

  await row(phone, id).click();
  await phone.testId('chat-item-permission').getByTestId('permission-allow').click();
  await expect(phone.testId('chat-title')).toContainText('Working');
  // Away in a new chat while it finishes: unread.
  await startNewChat(phone);
  await openSidebar(phone);
  await expect(phone.testId('section-chats').locator(`[data-session-id="${id}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await expect(row(phone, id).getByTestId('session-unread')).toBeVisible({ timeout: 15_000 });
  await expect(row(phone, id)).toContainText('3 tests passed');
  await row(phone, id).click();
  await expect(lastText(phone)).toContainText('3 tests passed');
  await openSidebar(phone);
  await expect(row(phone, id).getByTestId('session-unread')).toHaveCount(0);

  // A long turn shows as running.
  await row(phone, id).click();
  await send(phone, 'something long please');
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveAttribute('data-status', 'running');
  await row(phone, id).click();
  await phone.testId('composer-stop').click();
  await waitTurn(phone, 2, 'interrupted');
});

test('a question shows as a question in the sidebar', async ({ phone }) => {
  const id = await startChat(phone, 'claude', 'ask me');
  await expect(phone.testId('chat-item-question')).toHaveAttribute('data-status', 'pending');
  await openSidebar(phone);
  await expect(row(phone, id)).toHaveAttribute('data-status', 'waiting');
  await expect(row(phone, id).locator('.pill-attention')).toHaveText('Question');
});

test('slash commands: palette from the bar, filtered as you type, sent as a message', async ({ phone }) => {
  await newChat(phone, 'claude');
  // Before a session exists: the agent's own commands.
  await phone.testId('composer-slash').click();
  await expect(phone.testId('composer-input')).toHaveValue('/');
  const palette = phone.testId('slash-palette');
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId('slash-item').first()).toBeVisible();
  await phone.testId('composer-input').fill('/comp');
  await expect(palette.getByTestId('slash-item').first()).toHaveAttribute('data-command', /comp/);
  await shot(phone, 'slash');
  await palette.getByTestId('slash-item').first().click();
  await expect(phone.testId('composer-input')).toHaveValue(/^\/comp\S* $/);
  await expect(palette).toBeHidden();
  await phone.testId('composer-input').fill('hello');
  await phone.testId('composer-send').click();
  await waitTurn(phone, 1);
  // In the session: typing a slash lists its commands; the chosen one goes out as a message.
  await phone.testId('composer-input').fill('/');
  await expect(palette.getByTestId('slash-item').first()).toBeVisible();
  const name = await palette.getByTestId('slash-item').first().getAttribute('data-command');
  await palette.getByTestId('slash-item').first().click();
  await phone.testId('composer-send').click();
  await expect(phone.testId('chat-item-user').last()).toContainText(`/${name}`);
});
