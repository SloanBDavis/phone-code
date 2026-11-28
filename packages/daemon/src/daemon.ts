import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AdapterRegistry } from './agents/types.ts';
import { DeviceStore, publicDevice } from './auth/devices.ts';
import { PairingCodes } from './auth/pairing.ts';
import { DEFAULT_PORT, stateDir, statePaths } from './config.ts';
import { HostInfoProvider } from './host-info.ts';
import { startServer } from './http/server.ts';
import { WebAssets } from './http/web-assets.ts';
import { log } from './log.ts';
import { connectionInfo, resolvePublicUrl, type UrlSource } from './net/url.ts';
import { PushService } from './push.ts';
import { SessionManager } from './sessions/manager.ts';
import { ScreenWorker } from './sessions/screen.ts';
import { writeFileAtomic } from './util/files.ts';
import { CURSOR_APP, CursorBridge } from './agents/cursor-app/index.ts';
import { refreshCursor } from './cursor/hooks.ts';
import { ConnectionRegistry, SESSIONS_TOPIC, type ClientContext, type WsData } from './ws-client.ts';

export interface DaemonOptions {
  adapters: AdapterRegistry;
  port?: number;
  /**
   * Bind address. Default 127.0.0.1: phones reach the daemon through an https
   * proxy (tailscale serve, cloudflared, your own). The CLI only allows a
   * non-loopback address together with `insecure`.
   */
  hostname?: string;
  /** Public URL override: https, or loopback http (reverse proxy, ...). */
  publicUrl?: string;
  /** Start a Cloudflare quick tunnel and use its URL. */
  tunnel?: boolean;
  /** Serve plain http to the network (binds 0.0.0.0 unless `hostname`). */
  insecure?: boolean;
  /** With no --url/--tunnel/--insecure, try tailscale serve then cloudflared. Default true. */
  autoTunnel?: boolean;
  /** State directory; defaults to PHONECODE_HOME or ~/.phonecode. */
  home?: string;
}

export interface PairCode {
  code: string;
  expiresAt: number;
  pairUrl: string;
}

export interface Daemon {
  url: string;
  urlSource: UrlSource;
  /** False when only this computer can open `url` (no secure phone-reachable URL found). */
  phoneReachable: boolean;
  insecure: boolean;
  port: number;
  hostname: string;
  home: string;
  pair: PairCode;
  /** Mint a fresh pairing code (the previous ones stay valid until they expire). */
  newPairCode(): PairCode;
  stop(): Promise<void>;
}

export interface ControlFile {
  pid: number;
  port: number;
  token: string;
}

async function loadWebAssets(): Promise<WebAssets> {
  const here = import.meta.dir;
  const candidates = [
    process.env['PHONECODE_WEB_DIR'],
    // Compiled executable: embedded next to the entrypoint (/$bunfs/root/web).
    Bun.isStandaloneExecutable ? join(dirname(Bun.main), 'web') : undefined,
    join(here, '..', '..', 'web', 'dist'), // monorepo dev: packages/web/dist
  ].filter((p): p is string => p !== undefined && p !== '');
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return WebAssets.fromDisk(dir);
  }
  log.warn('web app not found (build packages/web); serving a placeholder page');
  log.debug(`looked in ${candidates.join(', ')}`);
  return WebAssets.empty();
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const home = opts.home ?? stateDir();
  const paths = statePaths(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const controlToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  // Claim the state dir before reading devices.json: from here on an offline
  // `phonecode revoke` sees a live daemon and refuses to edit the file under it.
  const starting: ControlFile = { pid: process.pid, port: 0, token: controlToken };
  await writeFileAtomic(paths.control, JSON.stringify(starting));

  const [devices, assets] = await Promise.all([DeviceStore.load(paths.devices), loadWebAssets()]);
  const push = await PushService.create(paths.vapid, devices);
  const serverRef: { current?: Bun.Server<WsData> } = {};
  // Cursor's desktop app, followed through its hooks: an adapter like the others,
  // fed by /_control/cursor/<event> instead of a process.
  const cursor = new CursorBridge({ hasDevices: () => devices.all().length > 0 });
  const adapters = { ...opts.adapters, [CURSOR_APP]: cursor.adapter() };
  const manager = await SessionManager.load(paths, adapters, {
    sessions(list) {
      serverRef.current?.publish(SESSIONS_TOPIC, JSON.stringify({ t: 'sessions', sessions: list }));
    },
    attention(session, reason) {
      push?.notify(session, reason);
    },
  });
  await manager.ensureDirs();

  cursor.attachManager(manager);
  // A Cursor connected by an older phone-code: its hook script and timeout follow this version.
  void refreshCursor().catch((err: unknown) => log.warn('could not update the Cursor hooks', err));
  const host = new HostInfoProvider(adapters);
  manager.catalogCommands = (agent) => host.commandsFor(agent);
  const pairing = new PairingCodes();
  const registry = new ConnectionRegistry();
  const client: ClientContext = { devices, manager, host, push, registry };
  const insecure = opts.insecure === true;
  const hostname = opts.hostname ?? (insecure ? '0.0.0.0' : '127.0.0.1');
  let publicUrl = '';

  // The link carries the long form of the code (never rate limited); the banner shows the typed form.
  const pairUrlFor = (link: string): string => `${publicUrl}/#/pair?c=${encodeURIComponent(link)}`;
  // Test hook: a shorter pairing code lifetime (the e2e suite checks expiry).
  const pairTtl = Number(process.env['PHONECODE_PAIR_TTL_MS']);
  const newPairCode = (): PairCode => {
    const { code, link, expiresAt } = pairing.create('pair', pairTtl > 0 ? pairTtl : undefined);
    return { code, expiresAt, pairUrl: pairUrlFor(link) };
  };

  const server = startServer({
    hostname,
    port: opts.port ?? DEFAULT_PORT,
    assets,
    devices,
    pairing,
    host,
    client,
    insecure,
    publicUrl: () => (publicUrl === '' ? undefined : publicUrl),
    control: {
      token: controlToken,
      newPairCode,
      status: () => ({ url: publicUrl, port: serverRef.current?.port ?? 0, pid: process.pid }),
      revoke(id) {
        // The device and every device paired through it (DeviceStore.revoke).
        const removed = devices.revoke(id);
        const [target, ...also] = removed;
        if (target === undefined) return undefined;
        for (const d of removed) registry.closeDevice(d.id);
        pairing.forgetDevices(new Set(removed.map((d) => d.id)));
        for (const d of removed) log.info(`revoked device "${d.name}" (${d.id})`);
        return { revoked: publicDevice(target), also: also.map(publicDevice) };
      },
      dropped(ids) {
        for (const id of ids) registry.closeDevice(id);
      },
      cursorHook: (event, input, signal) => cursor.handle(event, input, { signal }),
    },
  });
  serverRef.current = server;
  const port = server.port ?? opts.port ?? DEFAULT_PORT;
  log.debug(`listening on ${hostname}:${port} after ${performance.now().toFixed(1)} ms`);

  // Off the startup path: start the screen worker (it loads the terminal emulator).
  ScreenWorker.shared();

  const resolved = await resolvePublicUrl({
    ...(opts.publicUrl === undefined ? {} : { explicit: opts.publicUrl }),
    tunnel: opts.tunnel === true,
    insecure,
    auto: opts.autoTunnel !== false,
    bindHost: hostname,
    port,
  });
  const tunnel = resolved.helper;
  publicUrl = resolved.url;
  host.setConnection(connectionInfo(resolved));
  manager.historyIndex.warm();

  const fixed = process.env['PHONECODE_PAIR_CODE'];
  let pair: PairCode;
  if (fixed !== undefined && fixed !== '') {
    const code = pairing.addFixed(fixed);
    log.warn('PHONECODE_PAIR_CODE is set: that pairing code never expires and can be reused (testing only)');
    pair = { code, expiresAt: Number.POSITIVE_INFINITY, pairUrl: pairUrlFor(code) };
  } else {
    pair = newPairCode();
  }

  const control: ControlFile = { pid: process.pid, port, token: controlToken };
  await writeFileAtomic(paths.control, JSON.stringify(control));

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      log.info('shutting down…');
      registry.closeAll();
      await server.stop(true);
      tunnel?.stop();
      assets.close();
      await manager.shutdown();
      ScreenWorker.shared().terminate();
      await devices.flush();
      await rm(paths.control, { force: true });
    })();
    return stopping;
  };

  return {
    url: publicUrl,
    urlSource: resolved.source,
    phoneReachable: resolved.phoneReachable,
    insecure,
    port,
    hostname,
    home,
    pair,
    newPairCode,
    stop,
  };
}
