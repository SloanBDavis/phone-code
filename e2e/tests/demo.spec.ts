import { expect, test } from '../lib/fixtures.ts';
import { back, row, shot } from '../lib/ui.ts';

test('demo mode: main screens render without errors', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.goto('/?demo=1');
  await expect(phone.testId('screen-sessions')).toBeVisible();
  await expect(phone.testId('demo-banner')).toBeVisible();
  await expect(phone.testId('section-waiting')).toBeVisible();
  await expect(phone.testId('section-running')).toBeVisible();
  await expect(phone.testId('section-recent')).toBeVisible();
  await shot(phone, 'demo-sessions');

  // A chat waiting for approval.
  await row(phone, 'demo-auth').click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', 'demo-auth');
  await expect(phone.testId('chat-item-permission').last()).toHaveAttribute('data-status', 'pending');
  await shot(phone, 'demo-auth');
  await back(phone);

  // A finished turn with a sub-agent, todos, a table and code.
  await row(phone, 'demo-vite').click();
  await expect(phone.testId('chat-item-task').first()).toBeVisible();
  await expect(phone.testId('chat-item-todo').first()).toBeVisible();
  await expect(phone.testId('transcript').locator('table').first()).toBeVisible();
  await shot(phone, 'demo-vite');
  await back(phone);

  // A question.
  await row(phone, 'demo-chart').click();
  await expect(phone.testId('chat-item-question').last()).toHaveAttribute('data-status', 'pending');
  await back(phone);

  // The simulated terminal.
  await row(phone, 'demo-shell').click();
  await expect(phone.testId('screen-terminal')).toBeVisible();
  await expect(phone.testId('terminal').locator('.xterm-rows')).not.toHaveText('');
  await shot(phone, 'demo-shell');
  await back(phone);

  // Settings, in the demo.
  await phone.testId('open-settings').click();
  await expect(phone.testId('settings-exit-demo')).toBeVisible();
  await shot(phone, 'demo-settings');
  await phone.testId('settings-exit-demo').click();
  await expect(phone.testId('screen-pair')).toBeVisible();
});

test('demo mode: a very long transcript stays usable', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.goto('/?demo=1&demoItems=2000');
  await row(phone, 'demo-long').click();
  await expect(phone.testId('transcript')).toBeVisible();
  // Interactive right away: the composer takes input.
  await phone.testId('composer-input').fill('still responsive');
  await expect(phone.testId('composer-send')).toBeEnabled();
});

test('dark theme renders the main screens', async ({ newPhone }) => {
  const phone = await newPhone();
  await phone.page.emulateMedia({ colorScheme: 'dark' });
  await phone.page.goto('/?demo=1');
  await expect(phone.testId('section-recent')).toBeVisible();
  await shot(phone, 'dark-sessions');
  await row(phone, 'demo-vite').click();
  await expect(phone.testId('chat-item-task').first()).toBeVisible();
  await shot(phone, 'dark-chat');
  await back(phone);
  await row(phone, 'demo-auth').click();
  await expect(phone.testId('chat-item-permission').last()).toBeVisible();
  await shot(phone, 'dark-perm');
});
