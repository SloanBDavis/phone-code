// Renders scripts/icon.svg into the PNG sizes the PWA and iOS need.
// Usage: bun run icons   (needs Playwright's Chromium; set PLAYWRIGHT_PATH if
// `playwright` is not resolvable from here).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, '../public');
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
}

const src = readFileSync(resolve(here, 'icon.svg'), 'utf8');
// Rounded for favicons and in-app use; full-bleed squares for iOS (it masks
// the corners itself) and Android maskable icons.
const rounded = src.replaceAll('rx="RADIUS"', 'rx="230"');
const square = src.replaceAll(' rx="RADIUS"', '');

mkdirSync(resolve(pub, 'icons'), { recursive: true });
writeFileSync(resolve(pub, 'icons/icon.svg'), rounded);

const targets = [
  { file: 'apple-touch-icon.png', size: 180, svg: square },
  { file: 'icons/icon-192.png', size: 192, svg: square },
  { file: 'icons/icon-512.png', size: 512, svg: square },
  { file: 'icons/icon-maskable-512.png', size: 512, svg: square, pad: 0.1 },
  { file: 'icons/favicon-32.png', size: 32, svg: rounded, transparent: true },
];

const browser = await pw.chromium.launch();
async function render(t) {
  const inner = t.pad ? t.size * (1 - t.pad * 2) : t.size;
  const off = t.pad ? t.size * t.pad : 0;
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: t.size, height: t.size } });
  await page.setContent(
    `<html><body style="margin:0;background:${t.transparent ? 'transparent' : '#040605'}">` +
      `<div style="position:absolute;left:${off}px;top:${off}px;width:${inner}px;height:${inner}px">${t.svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div>` +
      `</body></html>`,
  );
  await page.screenshot({ path: resolve(pub, t.file), omitBackground: !!t.transparent });
  await page.close();
  console.log('wrote', t.file);
}
await Promise.all(targets.map(render));
await browser.close();
