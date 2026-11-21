/** Photos in the UI: attach several, remove one, upload with the message, view full screen. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Phone } from '../lib/fixtures.ts';
import { newChat, send, shot, waitTurn } from '../lib/ui.ts';

// 8x8 PNGs: red and blue.
const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC',
  'base64',
);
const BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOQi7qDFTEMLQkABzdVAUUsC+oAAAAASUVORK5CYII=',
  'base64',
);

function claudeTranscript(home: string): string {
  const root = join(home, '.claude', 'projects');
  let out = '';
  for (const dir of readdirSync(root))
    for (const f of readdirSync(join(root, dir)))
      if (f.endsWith('.jsonl')) out += readFileSync(join(root, dir, f), 'utf8');
  return out;
}

/** A one-finger drag on the viewer, as pointer events. */
async function drag(phone: Phone, dx: number, dy: number): Promise<void> {
  const box = await phone.testId('image-viewer').boundingBox();
  if (!box) throw new Error('no viewer');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await phone.page.mouse.move(x, y);
  await phone.page.mouse.down();
  for (let i = 1; i <= 8; i++) await phone.page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await phone.page.mouse.up();
}

test('send several photos, see them in the bubble, view them full screen', async ({ phone, daemon }) => {
  await newChat(phone, 'claude');
  const file = phone.testId('composer-file');
  await file.setInputFiles([
    { name: 'red.png', mimeType: 'image/png', buffer: RED },
    { name: 'blue.png', mimeType: 'image/png', buffer: BLUE },
  ]);
  await expect(phone.testId('composer-att')).toHaveCount(2);
  await phone.testId('att-remove').first().click();
  await expect(phone.testId('composer-att')).toHaveCount(1);
  await file.setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: RED });
  await expect(phone.testId('composer-att')).toHaveCount(2);
  await shot(phone, 'photos-composer');
  await send(phone, 'what is in these photos');
  // The bubble shows them right away, and keeps them once the host stored them.
  const bubble = phone.testId('chat-item-user');
  await expect(bubble.locator('[data-testid="chat-image"] img')).toHaveCount(2);
  await waitTurn(phone, 1);
  await expect(bubble.locator('[data-testid="chat-image"].loaded')).toHaveCount(2);
  // The agent received image blocks.
  await expect.poll(() => claudeTranscript(daemon.userHome)).toContain('"type":"image"');

  // Full screen: swipe between, double-tap zoom, swipe down to close.
  await bubble.getByTestId('chat-image').first().click();
  const viewer = phone.testId('image-viewer');
  await expect(viewer).toBeVisible();
  await expect(phone.testId('viewer-count')).toHaveText('1 of 2');
  await expect(viewer.locator('.viewer-img').first()).toBeVisible();
  await shot(phone, 'viewer');
  await drag(phone, -220, 0);
  await expect(viewer).toHaveAttribute('data-index', '1');
  await expect(phone.testId('viewer-count')).toHaveText('2 of 2');
  // Past the last one: rubber band, stays.
  await drag(phone, -220, 0);
  await expect(viewer).toHaveAttribute('data-index', '1');
  const box = await viewer.boundingBox();
  if (!box) throw new Error('no viewer');
  await phone.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(viewer).toHaveAttribute('data-zoomed', 'true');
  await phone.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(viewer).toHaveAttribute('data-zoomed', 'false');
  await expect(phone.testId('viewer-share')).toBeVisible();
  await drag(phone, 0, 260);
  await expect(viewer).toBeHidden();
});
