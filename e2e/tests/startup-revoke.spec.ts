/**
 * PairingAuth bug 5 (formal/README.md): while the daemon is starting it already
 * serves HTTP and the websocket, but control.json has no port yet. An offline
 * `phonecode revoke` used to edit devices.json under it; the daemon kept the
 * device in memory and wrote it back. The CLI must refuse instead.
 *
 * A fake `tailscale` holds the daemon in that window: `status` reports a
 * tailnet with HTTPS, `serve` never prints its URL until the test lets it exit.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { tokenWorks } from '../lib/ws.ts';

const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'box.tail-e2e.ts.net.', TailscaleIPs: ['100.64.0.1'] },
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: ['box.tail-e2e.ts.net'],
});

test('an offline revoke refuses while the daemon is still starting', async ({ daemon }) => {
  const phone = await daemon.pairDevice();
  const bin = join(daemon.root, 'fake-bin');
  const release = join(daemon.root, 'release-tailscale-serve');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'tailscale'),
    [
      '#!/bin/sh',
      `if [ "$1" = status ]; then echo '${STATUS}'; exit 0; fi`,
      `while [ ! -e '${release}' ]; do sleep 0.05; done`,
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'tailscale'), 0o755);

  const { ready } = await daemon.relaunch({
    local: false,
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });
  const serving = async (): Promise<boolean> => {
    try {
      return (await fetch(`${daemon.url}/api/health`)).ok;
    } catch {
      return false;
    }
  };
  await expect.poll(serving).toBe(true);
  expect(existsSync(release)).toBe(false); // still inside the startup window

  const refused = await daemon.cli('revoke', phone.deviceId);
  expect(refused.code, refused.out).toBe(1);
  expect(refused.out).toContain('not answering yet');
  expect(await tokenWorks(daemon, phone.token)).toBe(true);

  writeFileSync(release, '');
  await ready;
  const done = await daemon.cli('revoke', phone.deviceId);
  expect(done.code, done.out).toBe(0);
  expect(await tokenWorks(daemon, phone.token)).toBe(false);
});
