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
/** The PATH entry holding `bun` (the CLI and the fakes run under it). */
const BUN_DIR =
  (process.env['PATH'] ?? '').split(':').find((d) => d !== '' && existsSync(join(d, 'bun'))) ?? '';

/** A PATH with bun and the system tools, plus (optionally) a fake `tailscale`. */
function pathFor(daemon: Daemon, withTailscale: boolean): string {
  const bin = join(daemon.root, withTailscale ? 'ts-bin' : 'no-ts-bin');
  mkdirSync(bin, { recursive: true });
  if (withTailscale) {
    try {
      symlinkSync(FAKE, join(bin, 'tailscale'));
    } catch {
      // made by an earlier test
    }
  }
  return [bin, BUN_DIR, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

async function setup(daemon: Daemon, env: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await daemon.cliWith({ PHONECODE_JSON: '1', ...env }, 'setup');
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
    ['no-daemon', 'daemon-down', /systemctl enable --now tailscaled/],
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
  expect(String(none['next'])).toContain('tailscale.com/install.sh');

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
    { PATH: withTs, FAKE_TAILSCALE_STATE: 'no-https', PHONECODE_JSON: '0' },
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
