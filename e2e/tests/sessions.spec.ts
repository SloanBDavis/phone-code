import { expect, test, type Phone } from '../lib/fixtures.ts';
import { back, createSession, lastText, row, send, shot, waitTurn } from '../lib/ui.ts';

/** Swipe a session row left with a real touch gesture to reveal its actions. */
async function swipe(phone: Phone, sessionId: string): Promise<void> {
  const box = await row(phone, sessionId).boundingBox();
  if (box === null) throw new Error('row not visible');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width - 30;
  const cdp = await phone.context.newCDPSession(phone.page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number): Promise<unknown> =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', x0);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x0 - i * 20);
  await touch('touchEnd', x0 - 160);
  await cdp.detach();
  await expect(phone.page.locator('.swipe[data-open="true"]')).toHaveCount(1);
}

test('creates Claude, Codex and terminal sessions with the folder picker', async ({ phone }) => {
  const claude = await createSession(phone, 'claude');
  await expect(phone.testId('chat-title')).toContainText('Claude · project');
  await back(phone);
  const codex = await createSession(phone, 'codex', { folder: 'project/src' });
  await expect(phone.testId('chat-title')).toContainText('Codex · src');
  await back(phone);
  const term = await createSession(phone, 'terminal', { folder: 'other' });
  await back(phone);
  for (const id of [claude, codex, term]) await expect(row(phone, id)).toBeVisible();
  await expect(row(phone, codex)).toContainText('~/project/src');
  await expect(row(phone, term)).toContainText('~/other');
  // Recent folders are offered next time.
  await phone.testId('new-session').click();
  await expect(phone.testId('new-recent-dir')).toHaveCount(3);
  await shot(phone, 'new-session');
  await phone.testId('new-session-close').click();
  await expect(phone.testId('new-session-sheet')).toBeHidden();
  await shot(phone, 'sessions');
});

test('rename and delete from the list', async ({ phone }) => {
  const id = await createSession(phone, 'terminal');
  await back(phone);
  await swipe(phone, id);
  await phone.testId('session-rename').click();
  await phone.testId('rename-dialog-input').fill('My build shell');
  await phone.testId('rename-dialog-confirm').click();
  await expect(row(phone, id)).toContainText('My build shell');
  // Survives a reload (it is the daemon's state, not the page's).
  await phone.page.reload();
  await expect(row(phone, id)).toContainText('My build shell');

  await swipe(phone, id);
  await phone.testId('session-delete').click();
  await expect(phone.testId('delete-dialog')).toContainText('My build shell');
  await phone.testId('delete-dialog-confirm').click();
  await expect(row(phone, id)).toHaveCount(0);
  await phone.page.reload();
  await expect(phone.testId('screen-sessions')).toBeVisible();
  await expect(row(phone, id)).toHaveCount(0);
});

test('rename and delete from the chat menu', async ({ phone }) => {
  const id = await createSession(phone, 'claude');
  await phone.testId('chat-menu-btn').click();
  await phone.testId('menu-rename').click();
  await phone.testId('rename-dialog-input').fill('Renamed chat');
  await phone.testId('rename-dialog-confirm').click();
  await expect(phone.testId('chat-title')).toContainText('Renamed chat');
  // A manual title is not replaced by the first message.
  await send(phone, 'hello');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-title')).toContainText('Renamed chat');
  await phone.testId('chat-menu-btn').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog-confirm').click();
  await expect(phone.testId('screen-sessions')).toBeVisible();
  await expect(row(phone, id)).toHaveCount(0);
});

test('status sections and unread change live', async ({ phone }) => {
  const id = await createSession(phone, 'claude');
  await send(phone, 'run tests');
  await expect(phone.testId('chat-item-permission')).toHaveAttribute('data-status', 'pending');
  await back(phone);
  // Waiting for approval: "Needs you".
  const waiting = phone.testId('section-waiting');
  await expect(waiting.locator(`[data-session-id="${id}"]`)).toHaveAttribute('data-status', 'waiting');
  await expect(row(phone, id).locator('.pill-attention')).toHaveText('Approval');
  await shot(phone, 'sessions-waiting');

  await row(phone, id).click();
  await phone.testId('chat-item-permission').getByTestId('permission-allow').click();
  await expect(phone.testId('chat-title')).toContainText('Working');
  await back(phone);
  // Still working, then finished while nobody watched: Recent + unread.
  await expect(phone.testId('section-recent').locator(`[data-session-id="${id}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await expect(row(phone, id).getByTestId('session-unread')).toBeVisible();
  await expect(row(phone, id)).toContainText('3 tests passed');
  await row(phone, id).click();
  await expect(lastText(phone)).toContainText('3 tests passed');
  await back(phone);
  await expect(row(phone, id).getByTestId('session-unread')).toHaveCount(0);

  // A long turn shows under Running.
  await row(phone, id).click();
  await send(phone, 'something long please');
  await back(phone);
  await expect(phone.testId('section-running').locator(`[data-session-id="${id}"]`)).toBeVisible();
  await shot(phone, 'sessions-running');
  await row(phone, id).click();
  await phone.testId('composer-stop').click();
  await waitTurn(phone, 2, 'interrupted');
});

test('a question shows as a question in the list', async ({ phone }) => {
  const id = await createSession(phone, 'claude');
  await send(phone, 'ask me');
  await expect(phone.testId('chat-item-question')).toHaveAttribute('data-status', 'pending');
  await back(phone);
  await expect(row(phone, id)).toHaveAttribute('data-status', 'waiting');
  await expect(row(phone, id).locator('.pill-attention')).toHaveText('Question');
});
