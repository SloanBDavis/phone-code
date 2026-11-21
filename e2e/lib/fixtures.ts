/**
 * Test fixtures: one real daemon per test file, and "phones" (iPhone-sized
 * browser contexts) that fail the test on any unexpected console error or
 * uncaught page error.
 */
import { test as base, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Daemon, type DaemonOptions } from './daemon.ts';

export { expect };

const IPHONE = devices['iPhone 15 Pro'];

export class Phone {
  readonly errors: string[] = [];
  private readonly allowed: RegExp[] = [];

  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly daemon: Daemon,
  ) {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      this.errors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => this.errors.push(`pageerror: ${err.message}`));
  }

  /** Tolerate console errors matching `re` for the rest of the test. */
  allowConsole(re: RegExp): void {
    this.allowed.push(re);
  }

  unexpectedErrors(): string[] {
    return this.errors.filter((e) => !this.allowed.some((re) => re.test(e)));
  }

  testId(id: string): ReturnType<Page['getByTestId']> {
    return this.page.getByTestId(id);
  }

  /** Pair through the QR link, continue past the iOS install coach and land on the sessions list. */
  async pair(): Promise<void> {
    const { pairUrl } = await this.daemon.newPairCode();
    await this.page.goto(pairUrl);
    await expect(this.testId('pair-install')).toBeVisible();
    await this.testId('pair-continue').click();
    await expect(this.testId('screen-sessions')).toBeVisible();
    await expect(this.testId('conn-state')).toHaveAttribute('data-status', 'open');
  }

  /** The device id this phone was paired as (from storage). */
  async deviceId(): Promise<string> {
    return this.page.evaluate(() => {
      const raw = localStorage.getItem('pc.creds');
      return raw === null ? '' : (JSON.parse(raw) as { deviceId: string }).deviceId;
    });
  }
}

interface Fixtures {
  /** Extra daemon environment for this file (`test.use({ daemonOptions: … })`). */
  daemonOptions: DaemonOptions;
  daemon: Daemon;
  /** A paired phone on the sessions screen. */
  phone: Phone;
  /** Opens another, unpaired phone (fresh context, empty storage). */
  newPhone: () => Promise<Phone>;
}

interface WorkerFixtures {
  daemonPool: Map<string, Daemon>;
}

async function openPhone(browser: Browser, daemon: Daemon, phones: Phone[]): Promise<Phone> {
  const context = await browser.newContext({
    ...IPHONE,
    baseURL: daemon.url,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const p = new Phone(context, page, daemon);
  phones.push(p);
  return p;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  daemonOptions: [{}, { option: true }],
  daemonPool: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
    async ({}, use) => {
      const pool = new Map<string, Daemon>();
      await use(pool);
      await Promise.all([...pool.values()].map((d) => d.dispose()));
    },
    { scope: 'worker' },
  ],
  daemon: async ({ daemonPool, daemonOptions }, use, testInfo) => {
    // One daemon per test file: stop the previous file's daemon when a worker moves on.
    let d = daemonPool.get(testInfo.file);
    if (d === undefined) {
      for (const [file, old] of daemonPool) {
        daemonPool.delete(file);
        await old.dispose();
      }
      d = await Daemon.start(daemonOptions);
      daemonPool.set(testInfo.file, d);
    }
    if (!d.alive) await d.restart();
    await use(d);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('daemon-output', { body: d.output.slice(-20_000), contentType: 'text/plain' });
    }
  },
  newPhone: async ({ browser, daemon }, use, testInfo) => {
    const phones: Phone[] = [];
    await use(() => openPhone(browser, daemon, phones));
    const errors = phones.flatMap((p) => p.unexpectedErrors());
    await Promise.all(phones.map((p) => p.context.close()));
    if (testInfo.status === testInfo.expectedStatus) {
      expect(errors, 'unexpected console errors / page errors').toEqual([]);
    }
  },
  phone: async ({ newPhone }, use) => {
    const p = await newPhone();
    await p.pair();
    await use(p);
  },
});
