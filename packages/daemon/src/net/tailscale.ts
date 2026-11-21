/**
 * Tailscale integration. `tailscale serve <target>` (Tailscale >= 1.52) runs
 * in the foreground, proxies https://<machine>.<tailnet>.ts.net (port 443,
 * real certificate) to the target, and removes that config when the process
 * is interrupted. UNVERIFIED here: no Tailscale CLI was available while this
 * was written; the command shape follows Tailscale's `serve` documentation.
 */
import { existsSync } from 'node:fs';
import { isRecord, parseJson } from '../util/guards.ts';
import { waitForUrl, type Tunnel } from './tunnel.ts';

const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function tailscaleBin(): string | undefined {
  const found = Bun.which('tailscale');
  if (found !== null) return found;
  return process.platform === 'darwin' && existsSync(MAC_TAILSCALE) ? MAC_TAILSCALE : undefined;
}

interface TailscaleInfo {
  bin: string;
  /** HTTPS certificate domain, set only when the tailnet has HTTPS enabled. */
  certDomain: string | undefined;
  /** MagicDNS name or 100.x address. */
  address: string | undefined;
}

async function status(timeoutMs = 1500): Promise<TailscaleInfo | undefined> {
  const bin = tailscaleBin();
  if (bin === undefined) return undefined;
  try {
    const proc = Bun.spawn([bin, 'status', '--json'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    const st = parseJson(text);
    if (!isRecord(st) || st['BackendState'] !== 'Running') return undefined;
    const self = isRecord(st['Self']) ? st['Self'] : {};
    const tailnet = isRecord(st['CurrentTailnet']) ? st['CurrentTailnet'] : {};
    const certs: unknown = st['CertDomains'];
    const certDomain = Array.isArray(certs) ? certs.find((d): d is string => typeof d === 'string') : undefined;
    const dns = typeof self['DNSName'] === 'string' ? self['DNSName'].replace(/\.$/, '') : '';
    const ips: unknown = self['TailscaleIPs'];
    const ip = Array.isArray(ips)
      ? ips.find((v): v is string => typeof v === 'string' && v.startsWith('100.'))
      : undefined;
    return { bin, certDomain, address: tailnet['MagicDNSEnabled'] === true && dns !== '' ? dns : ip };
  } catch {
    return undefined;
  }
}

/** MagicDNS name (or 100.x address) of this machine, if Tailscale is up. */
export async function detectTailscale(): Promise<string | undefined> {
  return (await status())?.address;
}

/** Serve the local port at https://<machine>.<tailnet>.ts.net via `tailscale serve`. */
export async function startTailscaleServe(port: number, timeoutMs = 15_000): Promise<Tunnel | undefined> {
  const info = await status();
  if (info?.certDomain === undefined) return undefined; // not running, or HTTPS not enabled for the tailnet
  const proc = Bun.spawn([info.bin, 'serve', `http://127.0.0.1:${port}`], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const domain = info.certDomain.replaceAll('.', '\\.');
  // Foreground serve removes its config on interrupt, like pressing Ctrl+C.
  const tunnel = await waitForUrl('tailscale serve', proc, new RegExp(`https://${domain}`), timeoutMs, 'SIGINT');
  return { ...tunnel, url: `https://${info.certDomain}` };
}
