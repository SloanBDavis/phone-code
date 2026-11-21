#!/usr/bin/env bun
/**
 * phonecode CLI.
 *
 *   phonecode [--port 7777] [--url https://…] [--tunnel] [--local] [--insecure [--host addr]] [--no-qr]
 *   phonecode pair | devices | revoke <id>
 *
 * Security: the daemon refuses unencrypted transport by default. It binds
 * 127.0.0.1 and only advertises an https URL (tailscale serve, a cloudflared
 * quick tunnel, or --url) or a loopback one. Plain http to the network
 * requires --insecure, because anyone on the network could read the token
 * and the terminal.
 */
import { parseArgs } from 'node:util';
import { DeviceStore } from './auth/devices.ts';
import { banner, bold, dim, pairingBlock, secureUrlHelp } from './banner.ts';
import { DAEMON_VERSION, DEFAULT_PORT, envFlag, stateDir, statePaths } from './config.ts';
import { ControlClient } from './control-client.ts';
import { startDaemon, type DaemonOptions } from './daemon.ts';
import { log } from './log.ts';
import { isLoopbackHost, isLoopbackUrl, isSecureUrl } from './net/transport.ts';

const HELP = `${bold('phonecode')} ${dim(`v${DAEMON_VERSION}`)}: your terminal, Claude Code and Codex on your phone

Usage
  phonecode [options]        start the daemon and show a pairing QR code
  phonecode pair             show a fresh pairing QR code (daemon must be running)
  phonecode devices          list paired devices
  phonecode revoke <id>      revoke a paired device (id or unique prefix)

Options
  --port <n>     port to listen on (default ${DEFAULT_PORT}, moves up if busy)
  --url <url>    public https URL of your own reverse proxy to this port
  --tunnel       expose through a Cloudflare quick tunnel (needs cloudflared)
  --local        this computer only: no tailscale serve / cloudflared auto-setup
  --insecure     serve plain http to your network (anyone on it can read your
                 token and terminal); binds 0.0.0.0 unless --host is given
  --host <addr>  bind address (default 127.0.0.1; others need --insecure)
  --no-qr        do not print the QR code

  With no --url/--tunnel, phonecode uses \`tailscale serve\` (Tailscale with
  HTTPS enabled), else a cloudflared quick tunnel if installed, else it only
  listens on this computer and explains how to get an https URL.
  -v, --version  print the version
  -h, --help     show this help

Environment
  PHONECODE_HOME        state directory (default ~/.phonecode)
  PHONECODE_ECHO_AGENT  1 = use a built-in fake agent (development)
  PHONECODE_LOG         debug | info | warn | error
`;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

async function pairCommand(home: string, noQr: boolean): Promise<number> {
  const client = await ControlClient.connect(home);
  if (client === undefined) {
    process.stderr.write('phonecode is not running. Start it with `phonecode`.\n');
    return 1;
  }
  const pair = await client.pair();
  if (isLoopbackUrl(pair.pairUrl)) {
    // A QR code for a loopback URL is useless on a phone.
    const port = Number(new URL(pair.pairUrl).port);
    process.stdout.write(`\n${secureUrlHelp(port)}\n\n  On this computer you can open ${pair.pairUrl}\n\n`);
    return 0;
  }
  process.stdout.write(`\n${await pairingBlock(pair, !noQr)}\n\n`);
  return 0;
}

async function devicesCommand(home: string): Promise<number> {
  const client = await ControlClient.connect(home);
  const list =
    client === undefined ? (await DeviceStore.load(statePaths(home).devices)).list() : await client.devices();
  if (list.length === 0) {
    process.stdout.write('No paired devices.\n');
    return 0;
  }
  for (const d of list) {
    const push = d.push > 0 ? dim(' · push') : '';
    process.stdout.write(
      `${bold(d.id)}  ${d.name}  ${dim(`paired ${fmtTime(d.createdAt)} · last seen ${fmtTime(d.lastSeenAt)}`)}${push}\n`,
    );
  }
  return 0;
}

async function revokeCommand(home: string, id: string | undefined): Promise<number> {
  if (id === undefined || id === '') {
    process.stderr.write('Usage: phonecode revoke <device id>\n');
    return 1;
  }
  const client = await ControlClient.connect(home);
  let revoked: { id: string; name: string } | null | undefined;
  if (client === undefined) {
    const store = await DeviceStore.load(statePaths(home).devices);
    revoked = store.revoke(id);
    await store.flush();
  } else {
    revoked = await client.revoke(id);
  }
  if (revoked === null || revoked === undefined) {
    process.stderr.write(`No device matches "${id}" (run \`phonecode devices\`).\n`);
    return 1;
  }
  process.stdout.write(`Revoked ${revoked.name} (${revoked.id}).\n`);
  return 0;
}

async function loadAdapters(): Promise<DaemonOptions['adapters']> {
  if (envFlag('PHONECODE_ECHO_AGENT')) {
    const { createEchoAdapters } = await import('./dev/echo-agent.ts');
    return createEchoAdapters();
  }
  const { createAdapters } = await import('./agents/index.ts');
  return createAdapters();
}

async function serve(values: Record<string, string | boolean | undefined>): Promise<number> {
  const portArg = typeof values['port'] === 'string' ? Number(values['port']) : undefined;
  if (portArg !== undefined && (!Number.isInteger(portArg) || portArg < 1 || portArg > 65535)) {
    process.stderr.write('--port must be a number between 1 and 65535\n');
    return 1;
  }
  const insecure = values['insecure'] === true;
  const url = typeof values['url'] === 'string' ? values['url'] : undefined;
  if (url !== undefined && !/^https?:\/\/[^/\s]+/.test(url)) {
    process.stderr.write('--url must be an http(s) URL\n');
    return 1;
  }
  if (url !== undefined && !insecure && !isSecureUrl(url)) {
    process.stderr.write(
      '--url must be https:// (or http://localhost). Plain http would let anyone on the network\n' +
        'read your pairing code, device token and terminal. Put an HTTPS proxy in front, or pass --insecure.\n',
    );
    return 1;
  }
  const host = typeof values['host'] === 'string' ? values['host'] : undefined;
  if (host !== undefined && !insecure && !isLoopbackHost(host)) {
    process.stderr.write(
      `--host ${host} would serve plain http to the network, where anyone could read your token and\n` +
        'terminal. phone-code listens on 127.0.0.1 and reaches your phone through https instead.\n' +
        'Pass --insecure as well if you really want this.\n',
    );
    return 1;
  }
  const daemon = await startDaemon({
    adapters: await loadAdapters(),
    ...(portArg === undefined ? {} : { port: portArg }),
    ...(host === undefined ? {} : { hostname: host }),
    ...(url === undefined ? {} : { publicUrl: url }),
    tunnel: values['tunnel'] === true,
    insecure,
    autoTunnel: values['local'] !== true,
  });
  const json = envFlag('PHONECODE_JSON');
  const showQr = values['no-qr'] !== true;
  const interactive = process.stdin.isTTY && !json;
  if (json) {
    const ready = {
      url: daemon.url,
      port: daemon.port,
      pairCode: daemon.pair.code,
      pairUrl: daemon.pair.pairUrl,
    };
    process.stdout.write(`PHONECODE_READY ${JSON.stringify(ready)}\n`);
  } else {
    process.stdout.write(await banner(daemon, showQr, interactive));
  }

  if (interactive) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => {
      if (!daemon.phoneReachable) return;
      void pairingBlock(daemon.newPairCode(), showQr).then((block) => process.stdout.write(`\n${block}\n\n`));
    });
  }

  return new Promise<number>((resolve) => {
    let signals = 0;
    const onSignal = (): void => {
      signals += 1;
      if (signals > 1) {
        resolve(1);
        return;
      }
      process.stdin.pause();
      daemon.stop().then(
        () => resolve(0),
        (err: unknown) => {
          log.error('shutdown failed', err);
          resolve(1);
        },
      );
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        url: { type: 'string' },
        tunnel: { type: 'boolean' },
        insecure: { type: 'boolean' },
        local: { type: 'boolean' },
        'no-qr': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version === true) {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return 0;
  }
  const home = stateDir();
  const [command, arg] = positionals;
  switch (command) {
    case undefined:
    case 'start':
      return serve(values);
    case 'pair':
      return pairCommand(home, values['no-qr'] === true);
    case 'devices':
      return devicesCommand(home);
    case 'revoke':
      return revokeCommand(home, arg);
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

/** Run the CLI and exit with its status. */
export function run(): void {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      log.error('fatal:', err);
      process.exit(1);
    },
  );
}

if (import.meta.main) run();
