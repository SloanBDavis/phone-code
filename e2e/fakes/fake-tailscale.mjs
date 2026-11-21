#!/usr/bin/env bun
// Scripted stand-in for the `tailscale` CLI (see README.md). FAKE_TAILSCALE_STATE picks what it plays:
//   ready (default)  Running, MagicDNS on, an HTTPS cert domain; `serve` prints the URL and stays up
//   stopped          signed in but disconnected (BackendState "Stopped")
//   needs-login      BackendState "NeedsLogin"
//   starting         BackendState "Starting"
//   no-daemon        cannot reach tailscaled (exit 1, the real CLI's error text)
//   hang             `status` never answers (like the macOS app CLI seen hanging)
//   no-magicdns      Running, MagicDNS off
//   no-https         Running, MagicDNS on, no CertDomains
//   serve-disabled   ready, but `serve` prints the "Serve is not enabled" link and waits
// The shapes follow `tailscale status --json` and `tailscale serve` as documented; the real CLI
// was not available when this was written.
/* oxlint-disable no-await-in-loop */
const state = process.env.FAKE_TAILSCALE_STATE ?? 'ready';
const [cmd, ...rest] = process.argv.slice(2);
const DNS = 'box.tail-e2e.ts.net';

function status() {
  const backend =
    { stopped: 'Stopped', 'needs-login': 'NeedsLogin', starting: 'Starting' }[state] ?? 'Running';
  return {
    Version: '1.90.0-fake',
    BackendState: backend,
    Self: { DNSName: `${DNS}.`, TailscaleIPs: ['100.64.0.1'], Online: backend === 'Running' },
    CurrentTailnet: {
      Name: 'e2e@example.com',
      MagicDNSSuffix: 'tail-e2e.ts.net',
      MagicDNSEnabled: state !== 'no-magicdns',
    },
    CertDomains: state === 'no-https' || state === 'no-magicdns' ? null : [DNS],
  };
}

if (cmd === 'version') {
  process.stdout.write('1.90.0-fake\n');
  process.exit(0);
}
if (cmd === 'status') {
  if (state === 'hang') setInterval(() => {}, 60_000);
  else if (state === 'no-daemon') {
    process.stderr.write(
      "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)\n",
    );
    process.exit(1);
  } else {
    process.stdout.write(`${JSON.stringify(status(), null, 2)}\n`);
    process.exit(0);
  }
} else if (cmd === 'serve') {
  if (state === 'serve-disabled') {
    process.stdout.write(
      'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nFAKE\n\n',
    );
  } else {
    process.stdout.write(
      `Available within your tailnet:\n\nhttps://${DNS}/\n|-- / proxy ${rest.at(-1) ?? ''}\n\nPress Ctrl+C to exit.\n`,
    );
  }
  process.on('SIGINT', () => process.exit(0));
  setInterval(() => {}, 60_000);
} else {
  process.stderr.write(`fake-tailscale: unsupported command ${cmd}\n`);
  process.exit(2);
}
