import type { ConnectionInfo, HostInfo } from '@phone-code/protocol';

export interface Connection extends ConnectionInfo {
  /** What it is, in plain words. */
  label: string;
}

const LABELS: Record<ConnectionInfo['mode'], string> = {
  tailscale: 'Private connection through Tailscale',
  tunnel: 'Public https tunnel',
  url: 'Your own https address',
  lan: 'Plain http on your network',
  local: 'This computer only',
};

/**
 * How this phone reaches the host. Daemons that report it say so in
 * `HostInfo.connection`; for older ones it is inferred from the page address.
 */
export function connectionOf(h: HostInfo | null | undefined): Connection {
  const c = h?.connection ?? infer();
  return { ...c, label: LABELS[c.mode] };
}

function infer(): ConnectionInfo {
  const hostname = location.hostname;
  const secure = window.isSecureContext;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    return { mode: 'local', secure };
  if (hostname.endsWith('.ts.net')) return { mode: 'tailscale', secure };
  if (hostname.endsWith('.trycloudflare.com')) return { mode: 'tunnel', secure };
  return secure ? { mode: 'url', secure } : { mode: 'lan', secure };
}
