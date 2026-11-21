/**
 * What this phone can use on this computer, with one harness not installed:
 * the harness picker and "This computer" say what is missing and what to run.
 * (Plain http is covered in webkit.spec.ts, which serves on the LAN address.)
 */
import { expect, test } from '../lib/fixtures.ts';
import { openComputer, shot } from '../lib/ui.ts';

test.use({ daemonOptions: { env: { PHONECODE_CODEX_BIN: '/nonexistent/codex' } } });

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
