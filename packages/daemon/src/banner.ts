import { homedir } from 'node:os';
import { DAEMON_VERSION } from './config.ts';
import type { Daemon, PairCode } from './daemon.ts';

const useColor = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
const paint =
  (open: string) =>
  (s: string): string =>
    useColor ? `\u001B[${open}m${s}\u001B[0m` : s;
export const bold = paint('1');
export const dim = paint('2');
export const cyan = paint('36');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('1;31');

export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

async function qr(text: string): Promise<string> {
  const { default: qrcode } = await import('qrcode-terminal');
  return new Promise((resolve) => qrcode.generate(text, { small: true }, (out) => resolve(out)));
}

function indent(text: string, by = '  '): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? l : by + l))
    .join('\n');
}

const SOURCE_LABEL: Record<Daemon['urlSource'], string> = {
  explicit: 'custom URL',
  tunnel: 'Cloudflare tunnel',
  tailscale: 'Tailscale',
  lan: 'local network',
  local: 'this computer only',
};

export async function pairingBlock(pair: PairCode, showQr: boolean): Promise<string> {
  const lines: string[] = [];
  if (showQr) lines.push(indent(await qr(pair.pairUrl)));
  const expiry = Number.isFinite(pair.expiresAt)
    ? `expires in ${Math.round((pair.expiresAt - Date.now()) / 60_000)} min, single use`
    : 'fixed test code';
  lines.push(
    `  Scan with your phone's camera, or open:`,
    `  ${cyan(pair.pairUrl)}`,
    `  Pairing code ${bold(formatCode(pair.code))} ${dim(`(${expiry})`)}`,
  );
  return lines.join('\n');
}

/** Shown instead of a QR code when no secure phone-reachable URL exists. */
export function secureUrlHelp(port: number): string {
  return [
    `  ${yellow('!')} No secure address your phone can reach, so phone-code only listens on this computer.`,
    '    Get an https URL in one of three ways, then start phonecode again:',
    `    1. Tailscale with HTTPS certificates enabled ${dim('(tailscale.com/kb/1153/enabling-https)')}`,
    `    2. Install cloudflared ${dim('(a free quick tunnel is started automatically)')}`,
    `    3. Your own HTTPS reverse proxy to localhost:${port}: ${bold('phonecode --url https://your.host')}`,
    dim('    (--insecure serves plain http to your network: anyone on it can read your session.)'),
  ].join('\n');
}

const INSECURE_WARNING = [
  red('  !!! INSECURE: plain HTTP on your network !!!'),
  red('  Anyone on this network can read the pairing code, your device token and everything'),
  red('  in your terminal and chats, and can take over the session. Use only on a network you trust.'),
].join('\n');

export async function banner(d: Daemon, showQr: boolean, interactive: boolean): Promise<string> {
  const home = d.home.startsWith(homedir()) ? `~${d.home.slice(homedir().length)}` : d.home;
  const lines = ['', `  ${bold('phone-code')} ${dim(`v${DAEMON_VERSION}`)}`, ''];
  if (d.insecure) lines.push(INSECURE_WARNING, '');
  if (d.phoneReachable) {
    lines.push(await pairingBlock(d.pair, showQr));
  } else {
    lines.push(secureUrlHelp(d.port), '', `  On this computer you can open ${cyan(d.pair.pairUrl)}`);
  }
  lines.push(
    '',
    `  ${green('●')} Listening on ${d.hostname}:${d.port} ${dim(`· ${SOURCE_LABEL[d.urlSource]} · state ${home}`)}`,
  );
  const enter = interactive && d.phoneReachable ? 'Press Enter for a new pairing code · ' : '';
  lines.push(dim(`  ${enter}Ctrl+C to stop`), '');
  return lines.join('\n');
}
