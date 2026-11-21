import { networkInterfaces } from 'node:os';
import { log } from '../log.ts';
import { detectTailscale, startTailscaleServe } from './tailscale.ts';
import { isLoopbackUrl } from './transport.ts';
import { startQuickTunnel, type Tunnel } from './tunnel.ts';

export type UrlSource = 'explicit' | 'tunnel' | 'tailscale' | 'lan' | 'local';

export interface PublicUrl {
  url: string;
  source: UrlSource;
  /** A phone can open it (it is not a loopback URL). */
  phoneReachable: boolean;
  /** https, or loopback http. */
  secure: boolean;
  /** Helper process (tunnel / tailscale serve) to stop on exit. */
  helper?: Tunnel;
}

const VIRTUAL_IFACE = /^(?:docker|br-|veth|virbr|vmnet|utun|tun|tap|lo|awdl|llw|bridge|zt|tailscale)/;

function privateRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip.startsWith('100.')) return 4; // CGNAT / Tailscale without the CLI
  return 3;
}

/** Best LAN IPv4 address, preferring physical interfaces and private ranges. */
export function detectLanAddress(): string | undefined {
  const candidates: Array<{ ip: string; rank: number }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      candidates.push({ ip: a.address, rank: privateRank(a.address) + (VIRTUAL_IFACE.test(name) ? 10 : 0) });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.ip;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export interface ResolveOptions {
  /** --url, already validated as https or loopback http. */
  explicit?: string;
  /** --tunnel: Cloudflare quick tunnel. */
  tunnel: boolean;
  /** --insecure: advertise plain http on the network. */
  insecure: boolean;
  /** Try tailscale serve when nothing else was asked for. A public tunnel is never automatic. */
  auto: boolean;
  bindHost: string;
  port: number;
}

async function tryHelper(
  name: string,
  start: () => Promise<Tunnel | undefined>,
): Promise<Tunnel | undefined> {
  try {
    return await start();
  } catch (err) {
    log.warn(`${name} failed`, err);
    return undefined;
  }
}

/**
 * explicit --url > --tunnel > --insecure LAN URL > auto (tailscale serve,
 * private to the user's own devices) > loopback only. A public tunnel is
 * opt-in only. Never yields plain http beyond loopback
 * unless `insecure`.
 */
export async function resolvePublicUrl(opts: ResolveOptions): Promise<PublicUrl> {
  const local: PublicUrl = {
    url: `http://localhost:${opts.port}`,
    source: 'local',
    phoneReachable: false,
    secure: true,
  };
  if (opts.explicit !== undefined) {
    const url = opts.explicit.replace(/\/+$/, '');
    return { url, source: 'explicit', phoneReachable: !isLoopbackUrl(url), secure: true };
  }
  if (opts.tunnel) {
    const helper = await tryHelper('cloudflared tunnel', () => startQuickTunnel(opts.port));
    if (helper !== undefined)
      return { url: helper.url, source: 'tunnel', phoneReachable: true, secure: true, helper };
  }
  if (opts.insecure) {
    const specific = opts.bindHost !== '0.0.0.0' && opts.bindHost !== '::' ? opts.bindHost : undefined;
    const host = specific ?? (await detectTailscale()) ?? detectLanAddress();
    if (host === undefined) return local;
    const url = `http://${formatHost(host)}:${opts.port}`;
    return { url, source: 'lan', phoneReachable: !isLoopbackUrl(url), secure: isLoopbackUrl(url) };
  }
  if (opts.auto) {
    const ts = await tryHelper('tailscale serve', () => startTailscaleServe(opts.port));
    if (ts !== undefined)
      return { url: ts.url, source: 'tailscale', phoneReachable: true, secure: true, helper: ts };
  }
  return local;
}
