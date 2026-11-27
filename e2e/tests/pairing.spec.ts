import { expect, test, type Phone } from '../lib/fixtures.ts';
import { str } from '../lib/json.ts';
import { openComputer, shot } from '../lib/ui.ts';

/** Rejected pairing attempts make the browser log the 401 response. */
function allow401(phone: Phone): void {
  phone.allowConsole(/Failed to load resource: the server responded with a status of 401/);
}

test('pairs from the QR link', async ({ newPhone, daemon }) => {
  const phone = await newPhone();
  const { pairUrl } = await daemon.newPairCode();
  await phone.page.goto(pairUrl);
  // iOS Safari: the Add to Home Screen coach, then the app.
  await expect(phone.testId('pair-install')).toBeVisible();
  await shot(phone, 'pair-install');
  await phone.testId('pair-continue').click();
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');
  expect(new URL(phone.page.url()).hash).toBe('#/');
  // Straight into a ready-to-type chat with the first available harness.
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-draft', 'true');
  await expect(phone.testId('new-chat-empty')).toHaveAttribute('data-state', 'ready');
  await expect(phone.testId('composer-harness')).toHaveAttribute('data-harness', 'claude');
  await expect(phone.testId('starter')).not.toHaveCount(0);
  await shot(phone, 'first-chat');
  // Paired for good: a reload goes straight back in.
  await phone.page.reload();
  await expect(phone.testId('screen-chat')).toBeVisible();
  expect((await daemon.devices()).map((d) => d.id)).toContain(await phone.deviceId());
});

test('a bad code shows an error and offers manual pairing', async ({ newPhone }) => {
  const phone = await newPhone();
  allow401(phone);
  await phone.page.goto('/#/pair?c=WRONGCODE2');
  await expect(phone.testId('pair-error')).toContainText(/invalid or expired/i);
  await shot(phone, 'pair-error');
  await phone.testId('pair-error-continue').click();
  await expect(phone.testId('pair-manual')).toBeVisible();
  await shot(phone, 'pair-manual');
  // Pasting garbage and a wrong code.
  await phone.testId('pair-input').fill('not a code!');
  await phone.testId('pair-submit').click();
  await expect(phone.testId('pair-input-error')).toContainText('does not look like');
  await phone.testId('pair-input').fill('ABCDE-FGHJK');
  await phone.testId('pair-submit').click();
  await expect(phone.testId('pair-input-error')).toContainText(/invalid or expired/i);
});

test('pasting a valid code or link pairs', async ({ newPhone, daemon }) => {
  const phone = await newPhone();
  await phone.page.goto('/');
  await phone.testId('pair-input').fill((await daemon.newPairCode()).code.toLowerCase());
  await phone.testId('pair-submit').click();
  await expect(phone.testId('pair-install')).toBeVisible();

  const second = await newPhone();
  await second.page.goto('/');
  await second.testId('pair-input').fill((await daemon.newPairCode()).pairUrl);
  await second.testId('pair-submit').click();
  await expect(second.testId('pair-install')).toBeVisible();
});

test('a code works only once', async ({ newPhone, daemon }) => {
  const { pairUrl } = await daemon.newPairCode();
  const first = await newPhone();
  await first.page.goto(pairUrl);
  await expect(first.testId('pair-install')).toBeVisible();
  const second = await newPhone();
  allow401(second);
  await second.page.goto(pairUrl);
  await expect(second.testId('pair-error')).toContainText(/invalid or expired/i);
});

test('Home Screen handoff pairs a fresh app with empty storage', async ({ newPhone, daemon }) => {
  const safari = await newPhone();
  await safari.page.goto((await daemon.newPairCode()).pairUrl);
  await expect(safari.testId('pair-install')).toBeVisible();
  // The coach put a single-use handoff code in the URL and the manifest.
  await expect.poll(() => new URL(safari.page.url()).searchParams.get('h')).toBeTruthy();
  const code = new URL(safari.page.url()).searchParams.get('h') ?? '';
  const manifestHref = await safari.page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toContain(`h=${code}`);
  const manifest = {
    start_url: str(await (await fetch(new URL(manifestHref ?? '', daemon.url))).json(), 'start_url'),
  };
  expect(manifest.start_url).toBe(`/?h=${code}`);

  // The installed app: separate, empty storage, launched in standalone mode at start_url.
  const app = await newPhone();
  await app.context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await app.page.goto(manifest.start_url);
  await expect(app.testId('screen-chat')).toBeVisible();
  await expect(app.testId('conn-state')).toHaveAttribute('data-status', 'open');
  expect(new URL(app.page.url()).searchParams.get('h')).toBeNull();
  expect(await app.deviceId()).not.toBe(await safari.deviceId());

  // The handoff code is single-use.
  const again = await newPhone();
  allow401(again);
  await again.page.goto(manifest.start_url);
  await expect(again.testId('pair-error')).toBeVisible();
});

test('unpairing forgets the device on the host too', async ({ phone, daemon }) => {
  const id = await phone.deviceId();
  expect((await daemon.devices()).map((d) => d.id)).toContain(id);
  await openComputer(phone);
  await shot(phone, 'settings');
  await phone.testId('settings-unpair').click();
  await phone.testId('unpair-dialog-confirm').click();
  await expect(phone.testId('pair-manual')).toBeVisible();
  await expect.poll(async () => (await daemon.devices()).map((d) => d.id)).not.toContain(id);
  await phone.page.reload();
  await expect(phone.testId('pair-manual')).toBeVisible();
});

test('a revoked phone is sent back to pairing', async ({ phone, daemon }) => {
  const id = await phone.deviceId();
  const res = await daemon.cli('revoke', id);
  expect(res.code, res.out).toBe(0);
  expect(res.out).toContain('Revoked');
  await expect(phone.testId('pair-manual')).toBeVisible();
  await expect(phone.testId('pair-reason')).toContainText(/unpaired/i);
  await shot(phone, 'pair-revoked');
});

test('the same phone pairing again replaces its entry; another phone adds one', async ({
  newPhone,
  daemon,
}) => {
  const before = (await daemon.devices()).length;
  const phone = await newPhone();
  await phone.pair();
  const first = await phone.deviceId();
  expect(await daemon.devices()).toHaveLength(before + 1);

  // The QR scanned again from the same browser: a new token, still one device.
  await phone.pair();
  const second = await phone.deviceId();
  expect(second).not.toBe(first);
  const ids = (await daemon.devices()).map((d) => d.id);
  expect(ids).toHaveLength(before + 1);
  expect(ids).toContain(second);
  expect(ids).not.toContain(first);
  await expect(phone.testId('conn-state')).toHaveAttribute('data-status', 'open');

  // And a third time, to be sure it is not one-off.
  await phone.pair();
  expect(await daemon.devices()).toHaveLength(before + 1);

  // A different phone is a different device.
  const other = await newPhone();
  await other.pair();
  expect(await daemon.devices()).toHaveLength(before + 2);
});
