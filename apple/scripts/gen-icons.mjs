// Renders the web app's icon (packages/web/scripts/icon.svg) into the Apple
// app icon set: a full-bleed 1024 square for iOS (the system masks it) and
// the macOS sizes, drawn on the standard macOS grid (an 824 pt rounded square
// inside 1024, transparent margin). Needs Playwright's Chromium, like the web
// app's icon script: `node apple/scripts/gen-icons.mjs` from the repo root.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = resolve(repo, 'apple/PhoneCode/Assets.xcassets/AppIcon.appiconset');
const require = createRequire(resolve(repo, 'e2e/package.json'));
const { chromium } = require('@playwright/test');

const src = readFileSync(resolve(repo, 'packages/web/scripts/icon.svg'), 'utf8');
const square = src.replaceAll(' rx="RADIUS"', '');
// macOS: 824/1024 body with a ~185 radius (continuous corners are close enough at icon sizes).
const macBody = src.replaceAll('rx="RADIUS"', 'rx="185"');

const mac = [16, 32, 128, 256, 512].flatMap((s) => [
  { size: s, scale: 1 },
  { size: s, scale: 2 },
]);

const browser = await chromium.launch();
async function render(file, px, mode) {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: px, height: px } });
  const inner = mode === 'mac' ? Math.round((px * 824) / 1024) : px;
  const off = (px - inner) / 2;
  const svg = (mode === 'mac' ? macBody : square).replace('<svg ', `<svg width="${inner}" height="${inner}" `);
  const shadow = mode === 'mac' ? 'filter:drop-shadow(0 ' + px / 100 + 'px ' + px / 50 + 'px rgba(0,0,0,.35));' : '';
  await page.setContent(
    `<html><body style="margin:0;background:${mode === 'mac' ? 'transparent' : '#040605'}">` +
      `<div style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px;${shadow}">${svg}</div></body></html>`,
  );
  await page.screenshot({ path: resolve(out, file), omitBackground: mode === 'mac' });
  await page.close();
}

mkdirSync(out, { recursive: true });
const images = [{ filename: 'icon-ios-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }];
await render('icon-ios-1024.png', 1024, 'ios');
for (const m of mac) {
  const px = m.size * m.scale;
  const file = `icon-mac-${m.size}@${m.scale}x.png`;
  await render(file, px, 'mac');
  images.push({ filename: file, idiom: 'mac', scale: `${m.scale}x`, size: `${m.size}x${m.size}` });
}
// The same artwork as an image the pairing screen shows.
const imageSet = resolve(repo, 'apple/PhoneCode/Assets.xcassets/AppIconImage.imageset');
mkdirSync(imageSet, { recursive: true });
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 256, height: 256 } });
await page.setContent(
  `<html><body style="margin:0;background:#040605">${square.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`,
);
await page.screenshot({ path: resolve(imageSet, 'app-icon-256.png') });
await page.close();
await browser.close();
writeFileSync(resolve(out, 'Contents.json'), JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
console.log(`wrote ${images.length} icons to ${out}`);
