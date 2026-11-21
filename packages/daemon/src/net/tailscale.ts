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

/** The macOS app's bundled CLI (PHONECODE_TAILSCALE_APP overrides it, for tests on any OS). */
export function macAppCli(): string | undefined {
  const override = process.env['PHONECODE_TAILSCALE_APP'];
  if (override !== undefined && override !== '') return existsSync(override) ? override : undefined;
  return process.platform === 'darwin' && existsSync(MAC_TAILSCALE) ? MAC_TAILSCALE : undefined;
}

export function tailscaleBin(): string | undefined {
  return Bun.which('tailscale') ?? macAppCli();
}

/** Why the last `tailscale serve` did not give us a URL (shown by `phonecode setup`). */
export let lastServeError: string | undefined;

interface TailscaleInfo {
  bin: string;
  /** HTTPS certificate domain, set only when the tailnet has HTTPS enabled. */
  certDomain: string | undefined;
  /** MagicDNS name or 100.x address. */
  address: string | undefined;
}

/**
 * Ask the Tailscale CLI for its status. The whole call is raced against a
 * hard deadline and the child is SIGKILLed: the macOS app binary can ignore
 * SIGTERM or keep its stdout open, and startup must never wait on it.
 */
async function status(timeoutMs = 1500): Promise<TailscaleInfo | undefined> {
  const bin = tailscaleBin();
  if (bin === undefined) return undefined;
  let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      proc?.kill('SIGKILL');
      resolve(undefined);
    }, timeoutMs);
  });
  const query = async (): Promise<TailscaleInfo | undefined> => {
    proc = Bun.spawn([bin, 'status', '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    return parseStatus(bin, text);
  };
  try {
    return await Promise.race([query(), deadline]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function parseStatus(bin: string, text: string): TailscaleInfo | undefined {
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
  // Foreground serve removes its config on interrupt, like pressing Ctrl+C. When
  // Serve is not enabled for the tailnet it prints a login.tailscale.com link and waits.
  let tunnel;
  try {
    tunnel = await waitForUrl(
      'tailscale serve',
      proc,
      new RegExp(`https://${domain}|https://login\\.tailscale\\.com/f/serve\\S*`),
      timeoutMs,
      'SIGINT',
    );
  } catch (err) {
    lastServeError = err instanceof Error ? err.message : String(err);
    throw err;
  }
  if (tunnel.url.startsWith('https://login.tailscale.com/')) {
    tunnel.stop();
    lastServeError = `Serve is not enabled on your tailnet. Enable it here: ${tunnel.url}`;
    throw new Error(lastServeError);
  }
  lastServeError = undefined;
  return { ...tunnel, url: `https://${info.certDomain}` };
}
