import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './lib/global-setup.ts',
  // Each file gets its own daemon; files run in parallel, tests inside a file in order.
  fullyParallel: false,
  workers: 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  outputDir: './test-results',
  use: {
    browserName: 'chromium',
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
});
