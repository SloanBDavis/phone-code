/**
 * Revocation over HTTP and the websocket, from the test process (no browser):
 * the cascade through handoff codes, and regressions for the revocation bugs
 * the formal models found (formal/README.md, PairingAuth bugs 3 and 4).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { str } from '../lib/json.ts';
import { tokenWorks, WsClient } from '../lib/ws.ts';

test('revoking a device also revokes every device paired through its handoff codes', async ({ daemon }) => {
  const safari = await daemon.pairDevice();
  // The Home Screen app pairs with Safari's handoff code, and could mint its own.
  const appRes = await daemon.pairWith(await daemon.handoff(safari.token));
  const app = { deviceId: str(appRes.body, 'deviceId'), token: str(appRes.body, 'token') };
  const grandRes = await daemon.pairWith(await daemon.handoff(app.token));
  const grand = { deviceId: str(grandRes.body, 'deviceId'), token: str(grandRes.body, 'token') };
  const other = await daemon.pairDevice();
  // A handoff code the app minted but nobody redeemed yet.
  const pending = await daemon.handoff(app.token);

  const listed = await daemon.cli('devices');
  expect(listed.out).toContain(`via ${safari.deviceId}`);
  expect(listed.out).toContain(`via ${app.deviceId}`);

  const sockets = await Promise.all(
    [safari, app, grand, other].map((d) => WsClient.connect(daemon, d.token)),
  );
  const res = await daemon.cli('revoke', safari.deviceId);
  expect(res.code, res.out).toBe(0);
  expect(res.out).toContain(`(${safari.deviceId})`);
  expect(res.out).toContain(`Also revoked script (${app.deviceId})`);
  expect(res.out).toContain(`Also revoked script (${grand.deviceId})`);

  for (const s of sockets.slice(0, 3)) expect(await s.waitClosed()).toBe(4401);
  expect(sockets[3]?.closed).toBe(false);
  expect(await tokenWorks(daemon, safari.token)).toBe(false);
  expect(await tokenWorks(daemon, app.token)).toBe(false);
  expect(await tokenWorks(daemon, grand.token)).toBe(false);
  expect(await tokenWorks(daemon, other.token)).toBe(true);
  // Codes minted by any revoked device are gone too.
  expect((await daemon.pairWith(pending)).status).toBe(401);
  const ids = (await daemon.devices()).map((d) => d.id);
  expect(ids).toContain(other.deviceId);
  expect(ids).not.toContain(app.deviceId);
  sockets[3]?.close();
});

test('revoking a Home Screen app leaves the device it came from', async ({ daemon }) => {
  const safari = await daemon.pairDevice();
  const app = str((await daemon.pairWith(await daemon.handoff(safari.token))).body, 'deviceId');
  const res = await daemon.cli('revoke', app);
  expect(res.code, res.out).toBe(0);
  expect(res.out).not.toContain('Also revoked');
  expect(await tokenWorks(daemon, safari.token)).toBe(true);
});

test('unpairing from the phone cascades the same way', async ({ daemon }) => {
  const safari = await daemon.pairDevice();
  const app = str((await daemon.pairWith(await daemon.handoff(safari.token))).body, 'token');
  const res = await fetch(`${daemon.url}/api/unpair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${safari.token}` },
  });
  expect(res.status).toBe(200);
  expect(await tokenWorks(daemon, safari.token)).toBe(false);
  expect(await tokenWorks(daemon, app)).toBe(false);
});

// PairingAuth bug 3: a handoff code minted before the revocation paired a fresh device afterwards.
test('a handoff code minted before a revocation does not pair afterwards', async ({ daemon }) => {
  const phone = await daemon.pairDevice();
  const code = await daemon.handoff(phone.token);
  expect((await daemon.cli('revoke', phone.deviceId)).code).toBe(0);
  const res = await daemon.pairWith(code);
  expect(res.status).toBe(401);
});

// PairingAuth bug 4: "Revoked" was printed before devices.json was written; a crash brought the device back.
test('a revocation survives a crash right after the CLI reports it', async ({ daemon }) => {
  const phone = await daemon.pairDevice();
  const file = join(daemon.home, 'devices.json');
  const onDisk = (): boolean => {
    try {
      return readFileSync(file, 'utf8').includes(phone.deviceId);
    } catch {
      return false;
    }
  };
  // The device must be on disk first, or a crash could not bring it back.
  await expect.poll(onDisk).toBe(true);
  const res = await daemon.cli('revoke', phone.deviceId);
  expect(res.code, res.out).toBe(0);
  await daemon.kill();
  expect(onDisk()).toBe(false);
  await daemon.restart();
  expect(await tokenWorks(daemon, phone.token)).toBe(false);
});
