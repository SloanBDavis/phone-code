import { existsSync } from 'node:fs';
import { defineConfig, webkit } from '@playwright/test';

/**
 * Two projects: the full suite in Chromium (iPhone emulation), and a smoke
 * subset (tests/webkit.spec.ts) in real WebKit, Safari's engine, served over
 * plain http on the LAN address like an iPhone on Wi-Fi. WebKit is optional
 * locally: without it that project is left out with a note; CI installs it.
 */
const hasWebkit = (() => {
  try {
    return existsSync(webkit.executablePath());
  } catch {
    return false;
  }
})();
// Only when tests run (tools such as knip load this file too). CI must have it.
if (!hasWebkit && process.argv.includes('test') && process.env['CI']) {
  throw new Error('WebKit is not installed; CI runs the webkit project (bunx playwright install webkit).');
}
if (!hasWebkit && process.argv.includes('test')) {
  console.warn(
    '\n[e2e] WebKit is not installed: skipping the "webkit" smoke project (tests/webkit.spec.ts).\n' +
      '      Install it with: cd e2e && bunx playwright install --with-deps webkit\n',
  );
}

export default defineConfig({
  testDir: './tests',
  globalSetup: './lib/global-setup.ts',
  // Each file gets its own daemon; files run in parallel, tests inside a file in order.
  fullyParallel: false,
  workers: 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  // This suite is the gate before a push: one more try for a test that fails, so a
  // timing hiccup does not block it. A test that needs the retry is reported as flaky.
  retries: 1,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  outputDir: './test-results',
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /webkit\.spec\.ts$/ },
    ...(hasWebkit
      ? [{ name: 'webkit', use: { browserName: 'webkit' as const }, testMatch: /webkit\.spec\.ts$/ }]
      : []),
  ],
});
