# Contributing

Thanks for helping. Bug reports, fixes and agent compatibility reports (especially for Codex) are the most useful contributions right now. For anything bigger than a fix, open an issue first so we can agree on the shape.

Security problems: see [SECURITY.md](SECURITY.md), not the issue tracker.

## Setup

You need [Bun](https://bun.sh) (the version in `packageManager` in `package.json`), git, and for some tasks Java (TLA+) or Playwright's Chromium.

```sh
bun install
```

`bun install` also installs git hooks with [lefthook](https://lefthook.dev) (skipped when `CI` is set): a format check and lint on staged files before each commit, and `bun run test` (the checks and the end-to-end suite, about four minutes) before each push. That hook is the gate: CI only repeats it on main. Skip a hook once with `LEFTHOOK=0 git commit ...` or `LEFTHOOK=0 git push`.

## Layout

| Path                | What                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/daemon`   | The `phonecode` CLI and daemon (Bun). `src/cli.ts` is the entry point.                            |
| `packages/web`      | The phone app (Preact, Vite). `TESTIDS.md` lists the `data-testid` hooks the e2e suite relies on. |
| `packages/protocol` | WebSocket protocol types shared by both.                                                          |
| `e2e`               | Playwright suite against the real daemon, with fake `claude` / `codex` binaries in `e2e/fakes`.   |
| `formal`            | TLA+ specs, checked by `formal/check.sh`.                                                         |
| `scripts`           | Release build, npm launcher, screenshots, protocol doc generator, binary smoke test.              |
| `docs`              | Protocol reference and README screenshots.                                                        |

## Day to day

```sh
bun run dev                              # daemon from source (port 7777)
bun run --filter @phone-code/web build   # rebuild the app the daemon serves
bun run --filter @phone-code/web dev     # Vite dev server; use /?demo=1
PHONECODE_ECHO_AGENT=1 bun run dev       # fake agent instead of claude/codex
PHONECODE_HOME=/tmp/pc bun run dev       # throwaway state directory
```

Without Tailscale the daemon only listens on this computer; open the URL it prints in a desktop browser (with mobile emulation in the dev tools), or use the demo.

## Before you push

```sh
bun run check   # oxfmt --check, oxlint --type-aware, typecheck, knip
bun run e2e     # Playwright (needs Chromium: cd e2e && bunx playwright install chromium)
bun run test    # both: what the pre-push hook runs
bash formal/check.sh   # if you touched chat sync or pairing logic (needs Java 11+)
```

CI runs all three on every push and pull request, plus a build and a smoke test of the compiled binary.

- **Format:** `bun run format` (oxfmt) fixes it.
- **Lint:** oxlint with type-aware rules, configured in `.oxlintrc.json`. Warnings fail the build. Fix the code rather than disabling a rule inline; if a rule is wrong for the codebase, change the config in its own commit and say why.
- **Dead code:** knip (`knip.jsonc`) flags unused files and dependencies. Unused exports are not enforced yet; see them with `bunx knip --include exports,types`.
- **Dependencies:** versions are exact (`bunfig.toml` sets `exact = true`) and CI installs with `--frozen-lockfile`, so commit `bun.lock` with any dependency change.

## Protocol changes

`packages/protocol/src/index.ts` is the single source of truth for the wire protocol. If you change it:

1. Keep old clients working where you can (new fields optional), or bump `PROTOCOL_VERSION`.
2. Update both the daemon and the web app in the same change.
3. Regenerate the reference: `bun run docs:protocol`. `bun run check` fails while `docs/protocol.md` is out of date. The prose sections of that file are hand-written; update them if the behavior changed.

## Web app conventions

- Keep the first screen small: heavy modules (terminal, markdown, highlight.js, QR scanner) are loaded on demand. Check the initial gzip size reported by `vite build` before and after.
- Add a `data-testid` for anything a test needs to find, and list it in `packages/web/TESTIDS.md`.
- `bun run screenshots` regenerates `docs/screenshots` from the demo if you change how the main screens look.

## Releases

Maintainers only.

1. Bump `version` in `packages/daemon/package.json` and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The [release workflow](.github/workflows/release.yml) cross-compiles all four targets (`bun run release`), smoke-tests each on a native runner (install script, macOS code signature, pairing and a terminal round trip), then creates the GitHub release with the tarballs and `SHA256SUMS`. It fails if the tag does not match the package version.
4. Publish to npm by hand from the `npm-packages` artifact of that workflow run (or a local `bun run release`). Platform packages first, the launcher last, so `phone-code` never points at versions that do not exist yet:

   ```sh
   for f in phone-code-darwin-arm64 phone-code-darwin-x64 phone-code-linux-arm64 phone-code-linux-x64; do
     npm publish --access public "$f-0.2.0.tgz"
   done
   npm publish phone-code-0.2.0.tgz
   ```

   The platform packages are scoped (`@phone-code/<os>-<arch>`), so the publishing account needs the `phone-code` npm organization. The launcher (`phone-code`) lists all four as optional dependencies; npm installs only the one matching the user's OS and CPU, the same scheme esbuild and Biome use.

`bun run release` locally produces the same `release/` directory (git-ignored): `phonecode-<os>-<arch>.tar.gz`, `SHA256SUMS`, and `npm/` with the package directories and their `npm pack` tarballs. `bun scripts/smoke-binary.ts <path to phonecode>` checks a binary end to end.
