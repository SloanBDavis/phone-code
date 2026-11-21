/**
 * What stands between this computer and a private https URL through
 * Tailscale, checked in order, with one precise next step per state.
 * Every command is time-bounded and SIGKILLed past its deadline: the macOS
 * app's CLI has been seen to hang on `tailscale status`, and "Tailscale did
 * not answer" is a state of its own. UNVERIFIED against the real CLI here
 * (none in the development container); the e2e suite drives it with
 * e2e/fakes/fake-tailscale.mjs. Field names follow `tailscale status --json`.
 */
import { isRecord, parseJson } from '../util/guards.ts';
import { lastServeError, macAppCli, tailscaleBin } from './tailscale.ts';

export type TailscaleState =
  | 'not-installed'
  | 'no-answer'
  | 'daemon-down'
  | 'logged-out'
  | 'stopped'
  | 'starting'
  | 'no-magicdns'
  | 'no-https'
  | 'serve-failed'
  | 'ready';

export interface Diagnosis {
  state: TailscaleState;
  /** One line: what is the case. */
  summary: string;
  /** The next step(s) to take, in order. */
  next: string[];
  /** Set on macOS when only the app's bundled CLI exists (not on PATH). */
  cliNote?: string;
  /** The https name phones will use, when known. */
  domain?: string;
}

const DNS_ADMIN = 'https://login.tailscale.com/admin/dns';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command with a hard deadline; 'timeout' when it did not finish in time (it is then killed). */
export async function runBounded(
  argv: string[],
  timeoutMs: number,
): Promise<RunResult | 'timeout' | 'missing'> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return 'missing';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve('timeout');
    }, timeoutMs);
  });
  const work = (async (): Promise<RunResult> => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function installSteps(platform: string): string[] {
  if (platform === 'darwin')
    return [
      'Install Tailscale from https://tailscale.com/download/mac (Mac App Store or the standalone app), open it and sign in.',
      'Install it on your phone too and sign in with the same account.',
    ];
  if (platform === 'win32')
    return [
      'Install Tailscale from https://tailscale.com/download/windows and sign in.',
      'Install it on your phone too and sign in with the same account.',
    ];
  return [
    'Install Tailscale: curl -fsSL https://tailscale.com/install.sh | sh',
    'Then sign in: sudo tailscale up',
    'Install it on your phone too and sign in with the same account.',
  ];
}

export async function diagnoseTailscale(
  opts: { timeoutMs?: number; platform?: string } = {},
): Promise<Diagnosis> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const platform = opts.platform ?? process.platform;
  const onPath = Bun.which('tailscale');
  const bin = tailscaleBin();
  if (bin === undefined) {
    return {
      state: 'not-installed',
      summary: 'Tailscale is not installed on this computer.',
      next: installSteps(platform),
    };
  }
  const app = macAppCli();
  const cliNote =
    onPath === null && app !== undefined
      ? `The \`tailscale\` command is not on your PATH; phone-code uses the app's own CLI at ${app}. ` +
        'To use it in a terminal too, choose "Install CLI" in the Tailscale app\'s settings (standalone app), ' +
        `or add: alias tailscale="${app}"`
      : undefined;
  const withNote = (d: Diagnosis): Diagnosis => (cliNote === undefined ? d : { ...d, cliNote });
  const res = await runBounded([bin, 'status', '--json'], timeoutMs);
  const restart =
    platform === 'darwin'
      ? 'Quit Tailscale from the menu bar and open it again'
      : platform === 'win32'
        ? 'Restart the Tailscale service (or the app)'
        : 'Restart it: sudo systemctl restart tailscaled';
  if (res === 'missing')
    return {
      state: 'not-installed',
      summary: 'Tailscale could not be started.',
      next: installSteps(platform),
    };
  if (res === 'timeout') {
    return withNote({
      state: 'no-answer',
      summary: `Tailscale did not answer within ${Math.round(timeoutMs / 100) / 10} s (\`tailscale status\` hung).`,
      next: [
        `${restart}, then run \`phonecode setup\` again.`,
        'If it keeps hanging, update Tailscale. Meanwhile you can use one of the routes below.',
      ],
    });
  }
  const st = parseJson(res.stdout);
  if (!isRecord(st)) {
    const err = `${res.stderr} ${res.stdout}`.toLowerCase();
    if (/tailscaled|failed to connect|connection refused|is tailscale running|no such file/.test(err))
      return withNote({
        state: 'daemon-down',
        summary: 'Tailscale is installed but its background service is not running.',
        next: [
          platform === 'darwin'
            ? 'Open the Tailscale app (it runs the service) and click Connect.'
            : platform === 'win32'
              ? 'Start the Tailscale app.'
              : 'Start it: sudo systemctl enable --now tailscaled, then sudo tailscale up',
        ],
      });
    return withNote({
      state: 'daemon-down',
      summary: `Tailscale answered with an error: ${(res.stderr || res.stdout).trim().split('\n')[0] ?? ''}`,
      next: [`${restart}, then run \`phonecode setup\` again.`],
    });
  }
  const backend = typeof st['BackendState'] === 'string' ? st['BackendState'] : '';
  const up =
    platform === 'darwin' || platform === 'win32'
      ? 'Open the Tailscale app and'
      : 'Run: sudo tailscale up, or';
  if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth' || backend === 'NoState') {
    return withNote({
      state: 'logged-out',
      summary:
        backend === 'NeedsMachineAuth'
          ? 'This computer is waiting for an admin to approve it in your tailnet.'
          : 'Tailscale is not signed in on this computer.',
      next:
        backend === 'NeedsMachineAuth'
          ? ['Approve the machine at https://login.tailscale.com/admin/machines']
          : [`${up} sign in (\`tailscale up\` prints a login link).`],
    });
  }
  if (backend === 'Stopped')
    return withNote({
      state: 'stopped',
      summary: 'Tailscale is signed in but disconnected.',
      next: [
        platform === 'darwin' || platform === 'win32'
          ? 'Click Connect in the Tailscale app.'
          : 'Run: sudo tailscale up',
      ],
    });
  if (backend !== 'Running')
    return withNote({
      state: 'starting',
      summary: `Tailscale is still starting (state ${backend || 'unknown'}).`,
      next: ['Wait a few seconds and run `phonecode setup` again.'],
    });
  const tailnet = isRecord(st['CurrentTailnet']) ? st['CurrentTailnet'] : {};
  if (tailnet['MagicDNSEnabled'] !== true)
    return withNote({
      state: 'no-magicdns',
      summary: 'MagicDNS is turned off for your tailnet, so there is no https name for this computer.',
      next: [
        `Open ${DNS_ADMIN}, turn on MagicDNS, and under "HTTPS Certificates" click Enable HTTPS.`,
        'Then run `phonecode setup` again.',
      ],
    });
  const certs: unknown = st['CertDomains'];
  const domain = Array.isArray(certs) ? certs.find((d): d is string => typeof d === 'string') : undefined;
  if (domain === undefined)
    return withNote({
      state: 'no-https',
      summary: 'HTTPS certificates are not enabled for your tailnet.',
      next: [
        `Open ${DNS_ADMIN}, and under "HTTPS Certificates" click Enable HTTPS.`,
        'Then run `phonecode setup` again.',
      ],
    });
  if (lastServeError !== undefined)
    return withNote({
      state: 'serve-failed',
      summary: 'Tailscale is ready, but `tailscale serve` failed.',
      next: [lastServeError],
      domain,
    });
  return withNote({
    state: 'ready',
    summary: `Tailscale is ready: phones on your tailnet will open https://${domain}`,
    next: ['Start phone-code: phonecode (it runs `tailscale serve` and shows the QR code).'],
    domain,
  });
}

/** The routes that work without Tailscale, with what each costs. */
export function otherRoutes(port: number): string[] {
  return [
    'Without Tailscale:',
    '  Same Wi-Fi: phonecode --insecure',
    '    Plain http on your local network. It only works while the phone is on the same network,',
    '    and anyone else on that network can read the pairing code, your device token, your',
    '    terminal and your chats, and could take over the session. The browser also treats the',
    '    page as insecure, so notifications, a proper Home Screen app and the in-app QR scanner',
    '    do not work. Use it only on a network you trust, never on public Wi-Fi.',
    '  Public tunnel: phonecode --tunnel',
    '    A public https address through a Cloudflare quick tunnel (needs cloudflared). Anyone who',
    '    learns the address reaches the pairing page; the pairing code and device tokens still protect it.',
    `  Your own https reverse proxy to localhost:${port}: phonecode --url https://your.host`,
  ];
}
