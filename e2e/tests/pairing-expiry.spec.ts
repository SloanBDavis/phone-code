import { expect, test } from '../lib/fixtures.ts';

// Pairing codes from this daemon live one second.
test.use({ daemonOptions: { env: { PHONECODE_PAIR_TTL_MS: '1000' } } });

test('an expired code is refused', async ({ newPhone, daemon }) => {
  const { pairUrl } = await daemon.newPairCode();
  const issued = Date.now();
  await expect.poll(() => Date.now() - issued > 1500).toBe(true);
  const phone = await newPhone();
  phone.allowConsole(/status of 401/);
  await phone.page.goto(pairUrl);
  await expect(phone.testId('pair-error')).toContainText(/invalid or expired/i);
  // A fresh code still works.
  await phone.testId('pair-error-continue').click();
  await phone.testId('pair-input').fill((await daemon.newPairCode()).code);
  await phone.testId('pair-submit').click();
  await expect(phone.testId('pair-install')).toBeVisible();
});
