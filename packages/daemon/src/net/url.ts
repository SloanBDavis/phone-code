import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isRecord, parseJson } from '../util/guards.ts';

export type UrlSource = 'explicit' | 'tunnel' | 'tailscale' | 'lan' | 'local';

export interface PublicUrl {
  url: string;
  source: UrlSource;
}

const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function tailscaleBin(): string | undefined {
  const found = Bun.which('tailscale');
  if (found !== null) return found;
  return process.platform === 'darwin' && existsSync(MAC_TAILSCALE) ? MAC_TAILSCALE : undefined;
}

/** MagicDNS name (or 100.x address) of this machine, if Tailscale is up. */
export async function detectTailscale(timeoutMs = 1500): Promise<string | undefined> {
  const bin = tailscaleBin();
  if (bin === undefined) return undefined;
  try {
    const proc = Bun.spawn([bin, 'status', '--json'], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    const status = parseJson(text);
    if (!isRecord(status) || status['BackendState'] !== 'Running') return undefined;
    const self = isRecord(status['Self']) ? status['Self'] : {};
    const tailnet = isRecord(status['CurrentTailnet']) ? status['CurrentTailnet'] : {};
    const dns = typeof self['DNSName'] === 'string' ? self['DNSName'].replace(/\.$/, '') : '';
    if (tailnet['MagicDNSEnabled'] === true && dns !== '') return dns;
    const ips: unknown = self['TailscaleIPs'];
    if (!Array.isArray(ips)) return undefined;
    return ips.find((ip): ip is string => typeof ip === 'string' && ip.startsWith('100.'));
  } catch {
    return undefined;
  }
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

/** explicit --url > tunnel > Tailscale > LAN IPv4 > localhost. */
export async function resolvePublicUrl(opts: {
  explicit?: string;
  tunnel?: string;
  bindHost: string;
  port: number;
}): Promise<PublicUrl> {
  if (opts.explicit !== undefined) return { url: opts.explicit.replace(/\/+$/, ''), source: 'explicit' };
  if (opts.tunnel !== undefined) return { url: opts.tunnel, source: 'tunnel' };
  const loopbackOnly =
    opts.bindHost === '127.0.0.1' || opts.bindHost === 'localhost' || opts.bindHost === '::1';
  if (loopbackOnly) return { url: `http://localhost:${opts.port}`, source: 'local' };
  if (opts.bindHost !== '0.0.0.0' && opts.bindHost !== '::') {
    return { url: `http://${formatHost(opts.bindHost)}:${opts.port}`, source: 'lan' };
  }
  const ts = await detectTailscale();
  if (ts !== undefined) return { url: `http://${formatHost(ts)}:${opts.port}`, source: 'tailscale' };
  const lan = detectLanAddress();
  if (lan !== undefined) return { url: `http://${lan}:${opts.port}`, source: 'lan' };
  return { url: `http://localhost:${opts.port}`, source: 'local' };
}
