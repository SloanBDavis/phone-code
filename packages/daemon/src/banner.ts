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

export async function banner(d: Daemon, showQr: boolean, interactive: boolean): Promise<string> {
  const home = d.home.startsWith(homedir()) ? `~${d.home.slice(homedir().length)}` : d.home;
  const lines = [
    '',
    `  ${bold('phone-code')} ${dim(`v${DAEMON_VERSION}`)}`,
    '',
    await pairingBlock(d.pair, showQr),
    '',
    `  ${green('●')} Listening on ${d.hostname}:${d.port} ${dim(`· ${SOURCE_LABEL[d.urlSource]} · state ${home}`)}`,
  ];
  if (d.hostname === '0.0.0.0') {
    lines.push(
      dim('    Reachable from your network; every device must pair first. Use --host 127.0.0.1 to restrict.'),
    );
  }
  if (!d.url.startsWith('https://')) {
    lines.push(
      `  ${yellow('!')} ${dim('Plain HTTP: notifications and offline install need HTTPS (try --tunnel or --url).')}`,
    );
  }
  lines.push(dim(`  ${interactive ? 'Press Enter for a new pairing code · ' : ''}Ctrl+C to stop`), '');
  return lines.join('\n');
}
