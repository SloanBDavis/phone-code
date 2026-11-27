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

async function asMacApp(phone: Phone): Promise<void> {
  await phone.page.addInitScript({ content: MARK_MAC_APP });
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
