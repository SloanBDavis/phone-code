/**
 * What this phone can use on this computer, over plain http with one harness
 * not installed: the harness picker and "This computer" say what is missing
 * and the one step to fix it.
 */
import { expect, test } from '../lib/fixtures.ts';
import { openComputer, shot } from '../lib/ui.ts';

test.use({ daemonOptions: { insecure: true, env: { PHONECODE_CODEX_BIN: '/nonexistent/codex' } } });

test('an unavailable harness is dimmed with what to run on the computer', async ({ phone }) => {
  await phone.testId('composer-harness').click();
  const menu = phone.testId('harness-menu');
  const codex = menu.getByTestId('harness-codex');
  await expect(codex).toHaveClass(/dim/);
  await expect(codex).toContainText('npm i -g @openai/codex');
  // Ready ones come first.
  await expect(menu.getByRole('menuitem').first()).toHaveAttribute('data-testid', 'harness-claude');
  await shot(phone, 'harness-unavailable');
  await codex.click();
  const dialog = phone.testId('setup-dialog');
  await expect(dialog).toContainText('npm i -g @openai/codex');
  await phone.testId('setup-dialog-confirm').click();
  await expect(dialog).toBeHidden();
  // Still on a harness that works.
  await expect(phone.testId('composer-harness')).toHaveAttribute('data-harness', 'claude');

  await openComputer(phone);
  const agent = phone.page.locator('[data-testid="settings-agent"][data-agent="codex"]');
  await expect(agent).toContainText('Not set up');
  await expect(agent.getByTestId('setup-hint')).toContainText('npm i -g @openai/codex');
});

test('plain http: said once while pairing, and explained on This computer', async ({ newPhone, daemon }) => {
  const phone = await newPhone();
  await phone.page.goto((await daemon.newPairCode()).pairUrl);
  await expect(phone.testId('pair-insecure')).toContainText('https');
  await phone.testId('pair-continue').click();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  await expect(phone.testId('conn-state')).toHaveAttribute('data-secure', 'false');
  await expect(phone.testId('conn-state')).toContainText('Plain http');
  // The coach already said it: the first chat does not repeat it.
  await expect(phone.testId('new-chat-empty')).toBeVisible();
  await expect(phone.testId('http-note')).toHaveCount(0);

  await openComputer(phone);
  await expect(phone.testId('connection-mode')).toHaveAttribute('data-mode', 'lan');
  await expect(phone.testId('works-chat')).toHaveAttribute('data-ok', 'true');
  for (const id of ['works-notifications', 'works-offline', 'works-scanner'])
    await expect(phone.testId(id)).toHaveAttribute('data-ok', 'false');
  await expect(phone.testId('connection-fix')).toContainText('npx phone-code setup');
  await expect(phone.testId('notifications-note')).toContainText('https');
  await shot(phone, 'computer-http');
});

test('a browser that skipped the coach hears it once in the first chat', async ({ phone }) => {
  await phone.page.evaluate(() => localStorage.removeItem('pc.seen.http'));
  await phone.page.reload();
  await expect(phone.testId('http-note')).toBeVisible();
  await phone.testId('http-note-dismiss').click();
  await expect(phone.testId('http-note')).toHaveCount(0);
  await phone.page.reload();
  await expect(phone.testId('new-chat-empty')).toBeVisible();
  await expect(phone.testId('http-note')).toHaveCount(0);
});
