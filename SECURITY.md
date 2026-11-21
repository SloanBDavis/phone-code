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
- `/api/*`, `/ws` and `/_control/*` answer only requests whose `Host` is loopback, an IP address, the advertised URL's host, or a host of `PHONECODE_ALLOWED_ORIGINS` (421 otherwise). This stops DNS rebinding: a web page that points its own name at `127.0.0.1` cannot talk to the daemon as same-origin.
- `POST /api/*` with an `Origin` header from a foreign site is refused (403), so a web page cannot post a pairing attempt to the daemon (CSRF), spend a code or burn the rate limit.
- Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `frame-ancestors 'none'`; HSTS is added when the request came through an HTTPS proxy.

### Pairing

- Every pairing code has two forms, generated with a CSPRNG and rejection sampling: the **link** form in the QR code and pairing URL (26 characters, about 128 bits) and the **typed** form printed under it (10 characters from a 31-character alphabet, about 49 bits). Redeeming either one spends both.
- Codes are single use and expire after 5 minutes. At most 16 are active; older ones are dropped. Codes are compared in constant time.
- Failed attempts with the typed form are rate limited: 8 per minute per client and 40 per minute overall. Behind a local proxy (tunnel, `tailscale serve`, nginx) the client is the address the proxy reports (`CF-Connecting-IP`, the last `X-Forwarded-For` entry, or the Tailscale login), believed only from a loopback peer. The link form is never rate limited: it cannot be guessed at any rate, so nobody can lock out a QR scan or a handoff. What remains: someone who can reach `/api/pair` can keep the typed form blocked (40 wrong codes a minute from many addresses); scan the QR instead.
- The pairing URL puts the code in the fragment (`#/pair?c=`), which is not sent to the server or in a Referer.
- The QR code contains the URL and the code. Anyone who sees it while it is valid can pair instead of you. Only one device can come out of it; if the attacker is first, your phone shows "invalid or expired", so check `phonecode devices` if that happens.
- Home Screen handoff codes (for iOS, see the README) are minted only by an already paired device, are link-form only, and follow the same rules. While the install coach is open, Safari keeps a fresh one in the page URL (`?h=`) and the manifest, so it is in that browser's history; anyone who reads it within 5 minutes can pair a device. Such a device is a child of the one that minted the code, so revoking that one removes it.

### Devices

- A successful pairing returns a random 256-bit token. The daemon keeps only its SHA-256 hash, in `devices.json`.
- Every WebSocket must authenticate with `hello` and the token within 5 seconds; frames before that are limited to 4 KB. Browser WebSockets must come from the app's own origin, the advertised URL, a loopback origin, or one listed in `PHONECODE_ALLOWED_ORIGINS`.
- `phonecode revoke <id>` (or "Unpair" on the phone) invalidates a token and closes its connections. It also revokes every device paired through that device's handoff codes, transitively (its Home Screen app, and anything a thief with its token paired), and drops their unredeemed codes. `phonecode devices` shows the lineage (`via <id>`).

### Local control

- `phonecode pair`, `devices` and `revoke` talk to the running daemon through `/_control/*`. That endpoint accepts only direct loopback connections without proxy headers, carrying a random secret from `control.json` in the state directory.

### Data at rest

- State lives in `~/.phonecode` (or `$PHONECODE_HOME`): paired devices, the session list, chat transcripts, terminal scrollback, Web Push keys and the control secret. The directory is created with mode 0700 and files with 0600. Nothing is encrypted at rest.

### What is proven

`formal/tamarin/PhoneCode.spthy` is a Dolev-Yao model of pairing, handoff, `hello`, unpair/revoke and the control endpoint, proved with Tamarin for each deployment mode (see `formal/README.md`). Assuming TLS works (the phone checks the certificate), codes, tokens and the control secret are unguessable, the browser is honest (origin-scoped storage, no XSS) and `control.json` is private, it proves: a device token stays secret; a socket is authorized only for a device your phone paired, and a captured `hello` authorizes nothing else; a code yields at most one device; a handoff code binds the new device to the one that minted it; after a revocation neither the device nor anything paired through it is accepted; only your CLI can use `/_control`, whatever a network attacker or a web page does. These hold for Tailscale, a trusted tunnel operator, your own proxy and loopback, with a confidential QR. The model also shows what fails: with a seen QR or a leaked handoff URL and a reachable endpoint, the attacker can win the race for that one code; with `--insecure` or a tunnel operator that is the attacker, everything is lost. Availability (the rate limit) and in-flight requests are outside the symbolic model.

## Limits: what phone-code does not protect against

- **A paired phone is a shell.** Anyone who can open the app on your unlocked phone has your computer, as your user. The token sits in the app's local storage; there is no second factor and no per-session lock.
- **Agents act with your permissions.** phone-code passes your approvals through, but "Bypass permissions" and "Always allow" mean the agent runs commands without asking. Neither phone-code nor the agents sandbox your machine (Codex's own sandbox modes aside).
- **A token is a shell.** Revocation stops phone-code access, but whatever a thief did with the shell (it could read `control.json`, or add its own SSH key) is not undone.
- **`--tunnel` is public.** The `*.trycloudflare.com` URL is reachable by anyone who learns it, and Cloudflare terminates TLS, so Cloudflare can read the traffic. The token still protects the app, but you are trusting Cloudflare and the strength of the pairing code and its rate limit.
- **Tailscale trusts your tailnet.** Every device on it can reach the pairing screen (not the app, without a token). Tailscale HTTPS certificates are publicly logged, so the machine and tailnet names appear in Certificate Transparency logs.
- **Your own proxy (`--url`)** is as safe as you configure it.
- **Notifications** go through the push service of the phone's browser vendor (Apple, Google, Mozilla). Payloads are encrypted end to end (RFC 8291), but the service sees when notifications are sent.
- **The daemon and the browser are not hardened against a compromised computer or phone.** Malware running as you on either side gets what you have.
- The Tailscale and Cloudflare integrations follow those tools' documentation; the Tailscale path has not been tested against a real tailnet yet.
