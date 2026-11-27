/**
 * The Mac app's window is this web app in a web view (apple/PhoneCode/Mac/WebShell.swift):
 * a desktop-sized page marked `html.mac-app`, with the pairing handed in by the app.
 * These tests are that page in a browser of the same size.
 */
import { expect, test, type Phone } from '../lib/fixtures.ts';
import { send, shot, waitTurn } from '../lib/ui.ts';

/** The app's boot script, as far as the page's look goes: `html.mac-app`, set before the page's own code runs. */
const MARK_MAC_APP = `(function () {
  var mark = function () { document.documentElement.classList.add('mac-app'); };
  if (document.documentElement) mark();
  else new MutationObserver(function (_, o) {
    if (!document.documentElement) return;
    mark();
    o.disconnect();
  }).observe(document, { childList: true });
})();`;

const near = (a: number | undefined, b: number): boolean => Math.abs((a ?? -99) - b) <= 1;

/**
 * The window's title strip: the app lays a native view over the top 28 points that moves
 * the window and takes every click there. Here it is an element that does the same, so a
 * button of the page that slides under it cannot be clicked in these tests either.
 */
const WINDOW_STRIP = `addEventListener('DOMContentLoaded', function () {
  var strip = document.createElement('div');
  strip.setAttribute('data-testid', 'window-strip');
  strip.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647';
  document.body.appendChild(strip);
});`;

async function asMacApp(phone: Phone): Promise<void> {
  await phone.page.addInitScript({ content: MARK_MAC_APP });
  await phone.page.addInitScript({ content: WINDOW_STRIP });
  await phone.page.setViewportSize({ width: 1280, height: 820 });
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
}

async function bothThemes(phone: Phone, name: string): Promise<void> {
  await phone.page.emulateMedia({ colorScheme: 'light' });
  await shot(phone, `${name}-light`);
  await phone.page.emulateMedia({ colorScheme: 'dark' });
  await shot(phone, `${name}-dark`);
}

test('the window: sidebar and chat side by side, below an empty strip for the window buttons', async ({
  phone,
}) => {
  await asMacApp(phone);
  const app = phone.page.locator('.app');
  const box = await app.boundingBox();
  expect(box?.y).toBe(28);
  expect(box?.width).toBe(1280);
  expect(box?.height).toBe(820 - 28);
  await expect(phone.testId('shell')).toHaveClass(/\bwide\b/);
  await bothThemes(phone, 'mac-new-chat');

  await send(phone, 'please run tests');
  await phone.testId('chat-item-permission').getByTestId('permission-allow').click();
  await waitTurn(phone, 1);
  await send(phone, 'edit file');
  await phone.testId('chat-item-permission').last().getByTestId('permission-allow').click();
  await waitTurn(phone, 2);
  await bothThemes(phone, 'mac-chat');
});

test('the sidebar resizes by its edge, the computer opens as a dialog, the context ring names its tokens', async ({
  phone,
}) => {
  await asMacApp(phone);
  const sidebar = phone.testId('sidebar');
  expect((await sidebar.boundingBox())?.width).toBe(320);
  const edge = phone.testId('sidebar-resizer');
  const at = await edge.boundingBox();
  if (at === null) throw new Error('no resizer');
  await phone.page.mouse.move(at.x + at.width / 2, 400);
  await phone.page.mouse.down();
  await phone.page.mouse.move(250, 400, { steps: 5 });
  await phone.page.mouse.up();
  expect((await sidebar.boundingBox())?.width).toBe(250);
  // Kept for next time, within its limits.
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  expect((await sidebar.boundingBox())?.width).toBe(250);
  expect((await phone.page.locator('.main').boundingBox())?.x).toBe(250);

  // "This computer" is a dialog in the middle of the window, not a phone's sheet.
  // Clicked at its top edge, right under the window's strip.
  await phone.testId('open-computer').click({ position: { x: 20, y: 2 } });
  const sheet = phone.testId('computer-sheet');
  await expect(sheet).toBeVisible();
  await phone.page.waitForTimeout(400);
  const box = await sheet.boundingBox();
  expect(box?.width).toBe(520);
  expect(Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2)).toBe(640);
  expect(box?.height).toBeLessThanOrEqual(680);
  await bothThemes(phone, 'mac-computer');
  await phone.page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  await send(phone, 'hello there');
  await waitTurn(phone, 1);
  const ring = phone.testId('context-ring');
  // Pointing at it shows the tokens where the percentage was.
  await expect(ring).toHaveText('21%', { useInnerText: true });
  await ring.hover();
  await expect(phone.testId('context-tokens')).toBeVisible();
  await expect(ring).toHaveText('42k / 200k', { useInnerText: true });
  await shot(phone, 'mac-context-hover');
  await phone
    .testId('composer-file')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(phone.testId('composer-att')).toHaveCount(1);
  await ring.hover();
  await shot(phone, 'mac-composer-file');
});

test('tiles: chats side by side, opened from the sidebar, kept for next time, closed one by one', async ({
  phone,
}) => {
  await asMacApp(phone);
  const panes = phone.testId('pane');
  const focusedPane = phone.page.locator('.pane.focused');
  const rows = phone.testId('session-row');

  await send(phone, 'first chat');
  await waitTurn(phone, 1);
  await expect(panes).toHaveCount(1);
  await expect(phone.testId('pane-close')).toHaveCount(0);

  // A new chat beside this one: two tiles, the new one focused, each half of the main area.
  await phone.testId('pane-split').click({ position: { x: 20, y: 2 } });
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveAttribute('data-focused', 'true');
  for (const i of [0, 1]) {
    const w = (await panes.nth(i).boundingBox())?.width ?? 0;
    expect(Math.abs(w - 480)).toBeLessThanOrEqual(1);
  }
  // Its first message makes it a chat, in the same tile.
  await focusedPane.getByTestId('composer-input').fill('second chat');
  await focusedPane.getByTestId('composer-send').click();
  await expect(panes.nth(1).getByTestId('chat-item-turn')).toHaveCount(1, { timeout: 20_000 });
  await expect(panes.nth(0).getByTestId('chat-item-user')).toContainText('first chat');
  await expect(panes.nth(1).getByTestId('chat-item-user')).toContainText('second chat');

  // A click in a tile focuses it; a chat already in a tile is focused, not opened twice.
  await panes.nth(0).getByTestId('composer-input').click();
  await expect(panes.nth(0)).toHaveAttribute('data-focused', 'true');
  await rows.filter({ hasText: 'second chat' }).click();
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveAttribute('data-focused', 'true');

  // A third chat, then out of its tile and back in by a Cmd-click and by a drag from the sidebar.
  await phone.testId('sidebar-new-chat').click();
  await expect(panes).toHaveCount(2);
  await focusedPane.getByTestId('composer-input').fill('third chat');
  await focusedPane.getByTestId('composer-send').click();
  await expect(focusedPane.getByTestId('chat-item-turn')).toHaveCount(1, { timeout: 20_000 });
  await rows.filter({ hasText: 'second chat' }).click({ modifiers: ['ControlOrMeta'] });
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(2).getByTestId('chat-item-user')).toContainText('second chat');
  await shot(phone, 'mac-tiles-3');
  await panes.nth(2).getByTestId('pane-close').click();
  await expect(panes).toHaveCount(2);
  await rows.filter({ hasText: 'second chat' }).dragTo(panes.nth(0), { targetPosition: { x: 20, y: 300 } });
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(2).getByTestId('chat-item-user')).toContainText('second chat');
  await expect(panes.nth(2)).toHaveAttribute('data-focused', 'true');

  // Four tiles are a 2 by 2 grid; that is as many as there are.
  await panes.nth(2).getByTestId('pane-split').click();
  await expect(panes).toHaveCount(4);
  await expect(phone.testId('pane-split')).toHaveCount(0);
  const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => panes.nth(i).boundingBox()));
  // The main area: 960 wide from x 320, 792 tall from y 28.
  for (const [i, b] of boxes.entries()) {
    expect(near(b?.width, 480), `tile ${i} width ${b?.width}`).toBe(true);
    expect(near(b?.height, 396), `tile ${i} height ${b?.height}`).toBe(true);
    expect(near(b?.x, 320 + (i % 2) * 480), `tile ${i} x ${b?.x}`).toBe(true);
    expect(near(b?.y, 28 + Math.floor(i / 2) * 396), `tile ${i} y ${b?.y}`).toBe(true);
  }
  await shot(phone, 'mac-tiles-grid');
  await panes.nth(3).getByTestId('pane-close').click();
  await panes.nth(2).getByTestId('pane-close').click();
  await expect(panes).toHaveCount(2);
  await bothThemes(phone, 'mac-tiles');

  // The tiles are there after a reload.
  await phone.page.reload();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(0).getByTestId('chat-item-user')).toContainText('first chat');
  await expect(panes.nth(1).getByTestId('chat-item-user')).toContainText('third chat');

  // Deleting a chat closes its tile; the last tile has nothing to close.
  await panes.nth(1).getByTestId('chat-title').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(panes).toHaveCount(1);
  await expect(phone.testId('pane-close')).toHaveCount(0);
  await expect(panes.nth(0).getByTestId('chat-item-user')).toContainText('first chat');

  // A phone-sized window shows the focused chat alone.
  await phone.testId('pane-split').click();
  await expect(panes).toHaveCount(2);
  await phone.page.setViewportSize({ width: 600, height: 820 });
  await expect(panes).toHaveCount(1);
});
