import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AdapterRegistry } from './agents/types.ts';
import { DeviceStore } from './auth/devices.ts';
import { PairingCodes } from './auth/pairing.ts';
import { DEFAULT_PORT, stateDir, statePaths } from './config.ts';
import { HostInfoProvider } from './host-info.ts';
import { startServer } from './http/server.ts';
import { WebAssets } from './http/web-assets.ts';
import { log } from './log.ts';
import { resolvePublicUrl, type UrlSource } from './net/url.ts';
import { startQuickTunnel, type Tunnel } from './net/tunnel.ts';
import { PushService } from './push.ts';
import { SessionManager } from './sessions/manager.ts';
import { ScreenWorker } from './sessions/screen.ts';
import { writeFileAtomic } from './util/files.ts';
import { ConnectionRegistry, SESSIONS_TOPIC, type ClientContext, type WsData } from './ws-client.ts';

export interface DaemonOptions {
  adapters: AdapterRegistry;
  port?: number;
  /** Bind address. Default 0.0.0.0 (all interfaces) so the phone can reach it. */
  hostname?: string;
  /** Public https URL override (reverse proxy, tailscale serve, ...). */
  publicUrl?: string;
  /** Start a Cloudflare quick tunnel and use its URL. */
  tunnel?: boolean;
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

  const [devices, assets] = await Promise.all([DeviceStore.load(paths.devices), loadWebAssets()]);
  const push = await PushService.create(paths.vapid, devices);
  const serverRef: { current?: Bun.Server<WsData> } = {};
  const manager = await SessionManager.load(paths, opts.adapters, {
    sessions(list) {
      serverRef.current?.publish(SESSIONS_TOPIC, JSON.stringify({ t: 'sessions', sessions: list }));
    },
    attention(session, reason) {
      push?.notify(session, reason);
    },
  });
  await manager.ensureDirs();

  const host = new HostInfoProvider(opts.adapters);
  const pairing = new PairingCodes();
  const registry = new ConnectionRegistry();
  const client: ClientContext = { devices, manager, host, push, registry };
  const controlToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const hostname = opts.hostname ?? '0.0.0.0';
  let publicUrl = '';

  const pairUrlFor = (code: string): string => `${publicUrl}/#/pair?c=${encodeURIComponent(code)}`;
  const newPairCode = (): PairCode => {
    const { code, expiresAt } = pairing.create('pair');
    return { code, expiresAt, pairUrl: pairUrlFor(code) };
  };

  const server = startServer({
    hostname,
    port: opts.port ?? DEFAULT_PORT,
    assets,
    devices,
    pairing,
    host,
    client,
    publicOrigin: () => (publicUrl === '' ? undefined : new URL(publicUrl).origin),
    control: {
      token: controlToken,
      newPairCode,
      status: () => ({ url: publicUrl, port: serverRef.current?.port ?? 0, pid: process.pid }),
      revoke(id) {
        const removed = devices.revoke(id);
        if (removed === undefined) return undefined;
        registry.closeDevice(removed.id);
        log.info(`revoked device "${removed.name}" (${removed.id})`);
        return {
          id: removed.id,
          name: removed.name,
          createdAt: removed.createdAt,
          lastSeenAt: removed.lastSeenAt,
          push: 0,
        };
      },
    },
  });
  serverRef.current = server;
  const port = server.port ?? opts.port ?? DEFAULT_PORT;
  log.debug(`listening on ${hostname}:${port} after ${performance.now().toFixed(1)} ms`);

  // Off the startup path: start the screen worker (it loads the terminal emulator).
  ScreenWorker.shared();

  let tunnel: Tunnel | undefined;
  if (opts.tunnel === true) {
    try {
      tunnel = await startQuickTunnel(port);
    } catch (err) {
      log.error('tunnel failed, falling back to direct URL:', err);
    }
  }
  const resolved = await resolvePublicUrl({
    ...(opts.publicUrl === undefined ? {} : { explicit: opts.publicUrl }),
    ...(tunnel === undefined ? {} : { tunnel: tunnel.url }),
    bindHost: hostname,
    port,
  });
  publicUrl = resolved.url;

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

  return { url: publicUrl, urlSource: resolved.source, port, hostname, home, pair, newPairCode, stop };
}
