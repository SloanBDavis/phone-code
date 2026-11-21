#!/usr/bin/env bun
/**
 * Regenerate docs/screenshots/*.png from the real web app in demo mode
 * (`/?demo=1`), at iPhone 15 Pro size, in dark and light.
 *
 * It uses the Playwright that the e2e workspace already depends on and the
 * Chromium it already installed (`bunx playwright install chromium` in e2e/
 * if you have none). The web app is built first unless --skip-build is given,
 * then served by the daemon from source on a loopback port.
 *
 * Usage: bun scripts/screenshots.ts [--skip-build]
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const outDir = join(root, 'docs', 'screenshots');

// The subset of Playwright used here; the package lives in the e2e workspace.
interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { state?: 'visible' }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  keyboard: {
    type(text: string, options?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
  };
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options: Record<string, unknown>): Promise<Context>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(): Promise<Browser> };
  devices: Record<string, Record<string, unknown>>;
}

function isPlaywright(v: unknown): v is Playwright {
  return typeof v === 'object' && v !== null && 'chromium' in v && 'devices' in v;
}
const pw: unknown = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
if (!isPlaywright(pw)) throw new Error('could not load @playwright/test from the e2e workspace');

interface Shot {
  name: string;
  /** Hash route inside the demo, e.g. `#/s/demo-auth`. */
  hash: string;
  ready: string;
  /** Optional interaction after load. */
  act?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  { name: 'sessions', hash: '#/', ready: '[data-testid="screen-sessions"]' },
  { name: 'chat-permission', hash: '#/s/demo-auth', ready: '[data-testid="screen-chat"]' },
  { name: 'chat-tools', hash: '#/s/demo-vite', ready: '[data-testid="screen-chat"]' },
  {
    name: 'terminal',
    hash: '#/s/demo-shell',
    ready: '[data-testid="screen-terminal"]',
    act: async (page) => {
      await page.click('[data-testid="screen-terminal"] .xterm');
      for (const cmd of ['git status', 'bun test']) {
        await page.keyboard.type(cmd, { delay: 20 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(1200); // the demo test run prints over ~1s
    },
  },
];

async function startDaemon(home: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const proc = Bun.spawn(['bun', join(root, 'packages', 'daemon', 'src', 'cli.ts'), '--local', '--no-qr'], {
    env: { ...process.env, PHONECODE_HOME: home, PHONECODE_JSON: '1', PHONECODE_ECHO_AGENT: '1' },
    stdout: 'pipe',
    stderr: 'inherit',
    stdin: 'ignore',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`daemon exited before it was ready:\n${buf}`);
    buf += decoder.decode(value);
    const m = /PHONECODE_READY (\{.*\})\n/.exec(buf);
    if (m?.[1] !== undefined) {
      const ready: unknown = JSON.parse(m[1]);
      const port = typeof ready === 'object' && ready !== null && 'port' in ready ? ready.port : undefined;
      if (typeof port !== 'number') throw new Error(`unexpected ready line: ${m[1]}`);
      reader.releaseLock();
      return {
        url: `http://127.0.0.1:${port}`,
        stop: async () => {
          proc.kill('SIGINT');
          await proc.exited;
        },
      };
    }
  }
}

if (!process.argv.includes('--skip-build')) {
  const build = Bun.spawn(['bun', 'run', '--filter', '@phone-code/web', 'build'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await build.exited) !== 0) throw new Error('web build failed');
}

mkdirSync(outDir, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'phonecode-shots-'));
const daemon = await startDaemon(home);
const browser = await pw.chromium.launch();
const iphone = pw.devices['iPhone 15 Pro'];
if (iphone === undefined) throw new Error('this Playwright has no "iPhone 15 Pro" device');
// Chromium, not WebKit: keep the iPhone metrics and touch, drop the WebKit-only default browser.
const { defaultBrowserType: _ignored, ...device } = iphone;

try {
  for (const scheme of ['dark', 'light'] as const) {
    const context = await browser.newContext({ ...device, colorScheme: scheme, serviceWorkers: 'block' });
    for (const shot of SHOTS) {
      const page = await context.newPage();
      await page.goto(`${daemon.url}/?demo=1${shot.hash}`);
      await page.waitForSelector(shot.ready, { state: 'visible' });
      await shot.act?.(page);
      // Let entrance transitions, fonts and the terminal renderer settle.
      await page.evaluate('document.fonts.ready');
      await page.waitForTimeout(1200);
      const path = join(outDir, `${shot.name}-${scheme}.png`);
      await page.screenshot({ path });
      console.log(`wrote ${path.slice(root.length + 1)}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
