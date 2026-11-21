import { expect, test } from '../lib/fixtures.ts';
import { openChat, openComputer, openSidebar, row, searchAll, shot } from '../lib/ui.ts';

test('demo mode: the main flows render without errors', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.goto('/?demo=1');
  // Opens into a ready new chat.
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'true');
  await expect(phone.testId('starter')).not.toHaveCount(0);
  await shot(phone, 'demo-new-chat');
  await openSidebar(phone);
  await expect(phone.testId('demo-banner')).toBeVisible();
  await expect(phone.testId('section-waiting')).toBeVisible();
  await expect(phone.testId('section-chats')).toBeVisible();
  // Archived chats are not in the sidebar.
  await expect(row(phone, 'demo-ci')).toHaveCount(0);
  await shot(phone, 'demo-sidebar');

  // A chat waiting for approval.
  await openChat(phone, 'demo-auth');
  await expect(phone.testId('chat-item-permission').last()).toHaveAttribute('data-status', 'pending');
  await shot(phone, 'demo-auth');

  // A finished turn with a sub-agent, todos, a table and code.
  await openChat(phone, 'demo-vite');
  await expect(phone.testId('chat-item-task').first()).toBeVisible();
  await expect(phone.testId('chat-item-todo').first()).toBeVisible();
  await expect(phone.testId('transcript').locator('table').first()).toBeVisible();
  await shot(phone, 'demo-vite');

  // Images in a bubble, a tool card and a message; the viewer.
  await openChat(phone, 'demo-design');
  await expect(phone.testId('chat-image')).toHaveCount(4);
  await phone.testId('chat-image').first().click();
  await expect(phone.testId('image-viewer')).toBeVisible();
  await expect(phone.testId('viewer-count')).toHaveText('1 of 2');
  await shot(phone, 'demo-viewer');
  await phone.testId('viewer-close').click();
  await expect(phone.testId('image-viewer')).toBeHidden();

  // A question.
  await openChat(phone, 'demo-chart');
  await expect(phone.testId('chat-item-question').last()).toHaveAttribute('data-status', 'pending');

  // The simulated terminal.
  await openChat(phone, 'demo-shell');
  await expect(phone.testId('terminal').locator('.xterm-rows')).not.toHaveText('');
  await shot(phone, 'demo-shell');

  // All chats: results from several harnesses, an archived one comes back.
  const rows = await searchAll(phone, 'the');
  await expect(rows.first()).toBeVisible();
  const agents = new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-agent'))));
  expect(agents.size).toBeGreaterThan(2);
  const archived = (await searchAll(phone, 'cache')).filter({ hasText: 'CI cache' });
  await expect(archived).toHaveAttribute('data-archived', 'true');
  await shot(phone, 'demo-search');
  await archived.click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', 'demo-ci');
  await openSidebar(phone);
  await expect(row(phone, 'demo-ci')).toBeVisible();

  // Slash commands from the session.
  await openChat(phone, 'demo-vite');
  await phone.testId('composer-input').fill('/');
  await expect(phone.testId('slash-group')).not.toHaveCount(1);
  await shot(phone, 'demo-slash');
  await phone.testId('composer-input').fill('');

  // This computer, in the demo.
  await openComputer(phone);
  await expect(phone.testId('settings-exit-demo')).toBeVisible();
  await shot(phone, 'demo-settings');
  await phone.testId('settings-exit-demo').click();
  await expect(phone.testId('screen-pair')).toBeVisible();
});

test('demo mode: archive, undo and a first message', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.goto('/?demo=1');
  await openSidebar(phone);
  await row(phone, 'demo-notes').click({ button: 'right' });
  await phone.testId('row-menu').getByTestId('menu-archive').click();
  await expect(row(phone, 'demo-notes')).toHaveCount(0);
  await phone.testId('toast-undo').click();
  await expect(row(phone, 'demo-notes')).toBeVisible();
  await phone.page.keyboard.press('Escape');
  await phone.testId('composer-input').fill('Add a dark mode toggle');
  await phone.testId('composer-send').click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', /.+/);
  await expect(phone.testId('chat-item-turn')).toHaveCount(1, { timeout: 20_000 });
});

test('demo mode: a very long transcript stays usable', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.goto('/?demo=1&demoItems=2000');
  await openChat(phone, 'demo-long');
  await expect(phone.testId('transcript')).toBeVisible();
  // Interactive right away: the composer takes input.
  await phone.testId('composer-input').fill('still responsive');
  await expect(phone.testId('composer-send')).toBeEnabled();
});

test('dark theme renders the main screens', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.emulateMedia({ colorScheme: 'dark' });
  await phone.page.goto('/?demo=1');
  await openSidebar(phone);
  await expect(phone.testId('section-chats')).toBeVisible();
  await shot(phone, 'dark-sidebar');
  await openChat(phone, 'demo-vite');
  await expect(phone.testId('chat-item-task').first()).toBeVisible();
  await shot(phone, 'dark-chat');
  await openChat(phone, 'demo-auth');
  await expect(phone.testId('chat-item-permission').last()).toBeVisible();
  await shot(phone, 'dark-perm');
});
