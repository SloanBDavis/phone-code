/**
 * `phonecode setup` against a scripted fake `tailscale` (e2e/fakes/fake-tailscale.mjs)
 * playing each state, plus a daemon that reaches phones through `tailscale serve`.
 * The real Tailscale CLI is not exercised here.
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { REPO, type Daemon } from '../lib/daemon.ts';
import { parse, record } from '../lib/json.ts';
import { WsClient } from '../lib/ws.ts';

const FAKE = join(REPO, 'e2e/fakes/fake-tailscale.mjs');
/** `bun`, which runs the CLI and the fakes. */
const BUN =
  (process.env['PATH'] ?? '')
    .split(':')
    .map((d) => join(d, 'bun'))
    .find((p) => p !== 'bun' && existsSync(p)) ?? 'bun';

/**
 * A PATH with `bun`, the base system tools, and (optionally) a fake
 * `tailscale`. Nothing else: a real `tailscale` in /usr/local/bin or beside
 * `bun` (a developer's Mac) must not stand in for the fake or for its absence.
 */
function pathFor(daemon: Daemon, withTailscale: boolean): string {
  const bin = join(daemon.root, withTailscale ? 'ts-bin' : 'no-ts-bin');
  mkdirSync(bin, { recursive: true });
  const link = (from: string, name: string): void => {
    if (!existsSync(join(bin, name))) symlinkSync(from, join(bin, name));
  };
  link(BUN, 'bun');
  if (withTailscale) link(FAKE, 'tailscale');
  return [bin, '/usr/bin', '/bin'].join(':');
}

/**
 * The hints name each platform's own way to install and start Tailscale; these
 * are the ones for the platform the suite runs on (Linux in CI, macOS for a
 * developer's run before a push).
 */
const MAC = process.platform === 'darwin';
const HINT = MAC
  ? { daemonDown: /Open the Tailscale app.*Connect/, install: 'tailscale.com/download/mac' }
  : { daemonDown: /systemctl enable --now tailscaled/, install: 'tailscale.com/install.sh' };

/**
 * Runs `phonecode setup`. A Mac running the suite may have the real Tailscale
 * app installed: an app path that does not exist keeps it out unless a case
 * names one.
 */
async function setup(daemon: Daemon, env: Record<string, string>): Promise<Record<string, unknown>> {
  const noApp = join(daemon.root, 'no-such-app');
  const r = await daemon.cliWith({ PHONECODE_JSON: '1', PHONECODE_TAILSCALE_APP: noApp, ...env }, 'setup');
  const line = r.out.split('\n').find((l) => l.startsWith('{'));
  expect(line, r.out).toBeDefined();
  const d = record(parse(line ?? '{}'));
  expect(r.code, r.out).toBe(d['state'] === 'ready' ? 0 : 1);
  return d;
}

test('setup diagnoses each Tailscale state with one next step', async ({ daemon }) => {
  const withTs = pathFor(daemon, true);
  const cases: Array<[string, string, RegExp]> = [
    ['ready', 'ready', /phonecode/],
    ['stopped', 'stopped', /tailscale up|Connect/],
    ['needs-login', 'logged-out', /sign in/],
    ['starting', 'starting', /Wait/],
    ['no-daemon', 'daemon-down', HINT.daemonDown],
    ['no-magicdns', 'no-magicdns', /login\.tailscale\.com\/admin\/dns.*MagicDNS/],
    ['no-https', 'no-https', /login\.tailscale\.com\/admin\/dns.*Enable HTTPS/],
  ];
  for (const [fake, state, next] of cases) {
    const d = await setup(daemon, { PATH: withTs, FAKE_TAILSCALE_STATE: fake });
    expect(d['state'], fake).toBe(state);
    expect(String(d['next']), fake).toMatch(next);
  }
  expect(await setup(daemon, { PATH: withTs })).toMatchObject({ domain: 'box.tail-e2e.ts.net' });

  // Not installed at all.
  const none = await setup(daemon, { PATH: pathFor(daemon, false) });
  expect(none['state']).toBe('not-installed');
  expect(String(none['next'])).toContain(HINT.install);

  // Only the macOS app's bundled CLI (not on PATH): used from there, with a note on how to enable it.
  const app = await setup(daemon, { PATH: pathFor(daemon, false), PHONECODE_TAILSCALE_APP: FAKE });
  expect(app['state']).toBe('ready');
  expect(String(app['cliNote'])).toContain('not on your PATH');

  // A CLI that never answers is its own state, reported after the deadline.
  const started = Date.now();
  const hung = await setup(daemon, { PATH: withTs, FAKE_TAILSCALE_STATE: 'hang' });
  expect(hung['state']).toBe('no-answer');
  expect(String(hung['summary'])).toContain('did not answer');
  expect(Date.now() - started).toBeLessThan(10_000);

  // Plain text for people: the state, the step and the routes without Tailscale.
  const text = await daemon.cliWith(
    {
      PATH: withTs,
      FAKE_TAILSCALE_STATE: 'no-https',
      PHONECODE_JSON: '0',
      PHONECODE_TAILSCALE_APP: join(daemon.root, 'no-such-app'),
    },
    'setup',
  );
  expect(text.code).toBe(1);
  expect(text.out).toContain('HTTPS certificates are not enabled');
  expect(text.out).toContain('phonecode --insecure');
  expect(text.out).toContain('anyone else on that network can read');
  expect(text.out).toContain('phonecode --tunnel');
  expect(text.out).toContain('phonecode --url https://your.host');
});

test('with Tailscale ready the daemon serves through tailscale serve', async ({ daemon }) => {
  const { ready } = await daemon.relaunch({ local: false, env: { PATH: pathFor(daemon, true) } });
  await ready;
  expect(daemon.url).toBe('https://box.tail-e2e.ts.net');
  // The daemon itself still answers on loopback; the advertised connection is Tailscale.
  daemon.url = `http://127.0.0.1:${daemon.port}`;
  const ws = await WsClient.connect(daemon, await daemon.pairToken());
  expect(record(ws.frames.find((f) => f.t === 'ready')?.['host'])['connection']).toEqual({
    mode: 'tailscale',
    secure: true,
  });
  ws.close();
});
