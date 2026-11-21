# Security

phone-code gives a phone remote control of a computer: a login shell as your user, and coding agents that can read, write and run anything you can. This document says what protects that access, what does not, and how to report a problem.

## Reporting a vulnerability

Please report privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. If that is not available, open an issue that says you have a security report and asks for a private contact, without any details. You should get an answer within a week. Fixes for confirmed issues go into the next release with credit, unless you prefer otherwise.

Only the latest release is supported.

## What is protected, and how

### Transport

- The daemon binds `127.0.0.1` by default. It reaches the phone only through an HTTPS proxy in front of that port: `tailscale serve` (automatic when available), a Cloudflare quick tunnel (`--tunnel`, opt-in), or your own proxy (`--url`).
- `/api/*` and `/ws` refuse any request that is not either a direct loopback connection or a loopback proxy reporting that the client used HTTPS (`X-Forwarded-Proto`, `Forwarded` or `CF-Visitor`). Proxy headers are believed only from a loopback peer.
- `--url` must be `https://` (or `http://localhost`). Binding to a non-loopback `--host` requires `--insecure`.
- `--insecure` turns those checks off and serves plain HTTP on the network. It prints a warning every time. Anyone who can see that traffic can read the pairing code, the device token and the whole session, and take it over.
- Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `frame-ancestors 'none'`; HSTS is added when the request came through an HTTPS proxy.

### Pairing

- A pairing code is 10 characters from a 31-character alphabet (about 49 bits), generated with a CSPRNG and rejection sampling.
- Codes are single use and expire after 5 minutes. At most 16 are active; older ones are dropped.
- Failed attempts are rate limited: 8 per minute per client address and 40 per minute overall. Codes are compared in constant time.
- The QR code contains the URL and the code. Anyone who sees it while it is valid can pair instead of you.
- Home Screen handoff codes (for iOS, see the README) are minted only for an already paired device, and follow the same rules.

### Devices

- A successful pairing returns a random 256-bit token. The daemon keeps only its SHA-256 hash, in `devices.json`.
- Every WebSocket must authenticate with `hello` and the token within 5 seconds; frames before that are limited to 4 KB. Browser WebSockets must come from the app's own origin, the advertised URL, a loopback origin, or one listed in `PHONECODE_ALLOWED_ORIGINS`.
- `phonecode revoke <id>` (or "Unpair" on the phone) invalidates a token and closes its connections.

### Local control

- `phonecode pair`, `devices` and `revoke` talk to the running daemon through `/_control/*`. That endpoint accepts only direct loopback connections without proxy headers, carrying a random secret from `control.json` in the state directory.

### Data at rest

- State lives in `~/.phonecode` (or `$PHONECODE_HOME`): paired devices, the session list, chat transcripts, terminal scrollback, Web Push keys and the control secret. The directory is created with mode 0700 and files with 0600. Nothing is encrypted at rest.

## Limits: what phone-code does not protect against

- **A paired phone is a shell.** Anyone who can open the app on your unlocked phone has your computer, as your user. The token sits in the app's local storage; there is no second factor and no per-session lock.
- **Agents act with your permissions.** phone-code passes your approvals through, but "Bypass permissions" and "Always allow" mean the agent runs commands without asking. Neither phone-code nor the agents sandbox your machine (Codex's own sandbox modes aside).
- **`--tunnel` is public.** The `*.trycloudflare.com` URL is reachable by anyone who learns it, and Cloudflare terminates TLS, so Cloudflare can read the traffic. The token still protects the app, but you are trusting Cloudflare and the strength of the pairing code and its rate limit.
- **Tailscale trusts your tailnet.** Every device on it can reach the pairing screen (not the app, without a token). Tailscale HTTPS certificates are publicly logged, so the machine and tailnet names appear in Certificate Transparency logs.
- **Your own proxy (`--url`)** is as safe as you configure it.
- **Notifications** go through the push service of the phone's browser vendor (Apple, Google, Mozilla). Payloads are encrypted end to end (RFC 8291), but the service sees when notifications are sent.
- **The daemon and the browser are not hardened against a compromised computer or phone.** Malware running as you on either side gets what you have.
- The Tailscale and Cloudflare integrations follow those tools' documentation; the Tailscale path has not been tested against a real tailnet yet.
