/**
 * Transport security rules. By default phone-code refuses plain HTTP beyond
 * loopback: the pairing code, the device token and the whole terminal would
 * otherwise cross the network readable by anyone on it.
 */

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Peer address as reported by the socket. */
export function isLoopbackIp(ip: string): boolean {
  return isLoopbackHost(ip);
}

/** https, or http to a loopback host (browsers treat that as a secure context). */
export function isSecureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Headers a local reverse proxy (cloudflared, tailscale serve, nginx…) adds. */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'forwarded',
  'cf-connecting-ip',
  'cf-visitor',
  'tailscale-user-login',
  'tailscale-headers-info',
];

export function isProxied(req: Request): boolean {
  return PROXY_HEADERS.some((h) => req.headers.has(h));
}

function cfScheme(req: Request): string | undefined {
  const raw = req.headers.get('cf-visitor');
  if (raw === null) return undefined;
  const m = /"scheme"\s*:\s*"([a-z]+)"/i.exec(raw);
  return m?.[1]?.toLowerCase();
}

function forwardedProto(req: Request): string | undefined {
  // The first hop is the client-facing one.
  const xfp = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (xfp !== undefined && xfp !== '') return xfp;
  const fwd = /(?:^|[;,\s])proto=([a-z]+)/i.exec(req.headers.get('forwarded') ?? '');
  return fwd?.[1]?.toLowerCase();
}

/** The request reached a trusted local proxy over https (only meaningful from a loopback peer). */
export function arrivedOverHttps(req: Request, ip: string, publicUrl: string | undefined): boolean {
  if (!isLoopbackIp(ip)) return false;
  if (forwardedProto(req) === 'https' || cfScheme(req) === 'https') return true;
  // tailscale serve: no scheme header is documented; trust our own https hostname.
  if (publicUrl?.startsWith('https://') === true) {
    try {
      return new URL(publicUrl).host === req.headers.get('host');
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Why this API/websocket request must be refused, or undefined if it is fine.
 * Accepted: a direct loopback connection, or a loopback proxy that says the
 * client used https. Headers are only believed from a loopback peer.
 */
export function transportRefusal(req: Request, ip: string): string | undefined {
  if (!isLoopbackIp(ip)) {
    return 'phone-code refuses unencrypted connections from the network. Use the https URL the daemon prints, or restart it with --insecure.';
  }
  const proto = forwardedProto(req) ?? cfScheme(req);
  if (proto !== undefined && proto !== 'https') {
    return 'This request reached phone-code through a proxy over plain http. Use the https URL.';
  }
  return undefined;
}
