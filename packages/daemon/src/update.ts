/**
 * Updates: `phonecode update`, and the question at startup when a newer
 * release is out.
 *
 * The latest version is read from where GitHub sends
 * `/releases/latest` (…/releases/tag/vX.Y.Z), at most once every 12 hours
 * (cached in the state directory). Installing is install.sh, the same script a
 * first install runs, pointed at the folder this executable is in: it
 * downloads, checks the checksum and swaps the file in one rename.
 */
import { dirname, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DAEMON_VERSION, envFlag } from './config.ts';
import { liveDaemonPid } from './control-client.ts';
import { readJson, writeFileAtomic } from './util/files.ts';
import { isRecord } from './util/guards.ts';

const REPO = 'SloanBDavis/phone-code';
const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
const SCRIPT_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const CHECK_EVERY_MS = 12 * 60 * 60_000;
const CHECK_TIMEOUT_MS = 2500;

/** `1.2.3` (or `v1.2.3`) as numbers; `undefined` for anything else, pre-releases included. */
export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The latest release's version, without the `v`. */
export async function latestVersion(timeoutMs = CHECK_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const res = await fetch(process.env['PHONECODE_LATEST_URL'] || LATEST_URL, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const tag = /\/releases\/tag\/v?([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1];
    return tag !== undefined && parseVersion(tag) !== undefined ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** How this phonecode got here, which decides how it is updated. */
export type InstallKind =
  | { kind: 'standalone'; path: string }
  | { kind: 'app'; path: string }
  | { kind: 'npm' }
  | { kind: 'source' };

export function installKind(): InstallKind {
  if (!Bun.isStandaloneExecutable) return { kind: 'source' };
  let path = process.execPath;
  try {
    path = realpathSync(path);
  } catch {
    // Keep the path as given.
  }
  if (path.includes(`.app${sep}Contents${sep}`)) return { kind: 'app', path };
  if (path.split(sep).includes('node_modules')) return { kind: 'npm' };
  return { kind: 'standalone', path };
}

const HOW: Record<Exclude<InstallKind['kind'], 'standalone'>, string> = {
  app: 'This phonecode is inside the Mac app: update the app (PhoneCode > Check for Updates).',
  npm: 'This phonecode was installed with npm: run `npm install -g phone-code@latest`.',
  source: 'This phonecode runs from source: `git pull` updates it.',
};

async function installScript(): Promise<string> {
  const local = process.env['PHONECODE_INSTALL_SCRIPT'];
  if (local) return Bun.file(local).text();
  const res = await fetch(SCRIPT_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`could not download the installer (${res.status})`);
  return res.text();
}

/** Downloads `version` over the executable at `path`. */
async function install(path: string, version: string): Promise<boolean> {
  const script = await installScript();
  const proc = Bun.spawn(['sh', '-s', '--', '--cli'], {
    stdin: new Blob([script]),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      PHONECODE_INSTALL: dirname(path),
      PHONECODE_VERSION: `v${version}`,
      PHONECODE_QUIET: '1',
    },
  });
  return (await proc.exited) === 0;
}

/** `phonecode update`: 0 when up to date or updated. */
export async function updateCommand(home: string): Promise<number> {
  const how = installKind();
  const latest = await latestVersion(15_000);
  if (latest === undefined) {
    process.stderr.write('Could not find the latest version (is github.com reachable?).\n');
    return 1;
  }
  if (!isNewer(latest, DAEMON_VERSION)) {
    process.stdout.write(`phonecode ${DAEMON_VERSION} is the latest version.\n`);
    return 0;
  }
  process.stdout.write(`phonecode ${latest} is available (this is ${DAEMON_VERSION}).\n`);
  if (how.kind !== 'standalone') {
    process.stdout.write(`${HOW[how.kind]}\n`);
    return 1;
  }
  try {
    if (!(await install(how.path, latest))) return 1;
  } catch (err) {
    process.stderr.write(`Update failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if ((await liveDaemonPid(home)) !== undefined) {
    process.stdout.write(
      'phonecode is running: stop it (Ctrl+C) and start it again to use the new version.\n',
    );
  }
  return 0;
}

interface UpdateState {
  checkedAt?: number;
  latest?: string;
  /** A version the user said no to: mentioned in one line from then on, not asked again. */
  declined?: string;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/**
 * At startup, at a terminal: when a newer release is out, offer it. Returns
 * true when it was installed (the caller then starts the new executable).
 * Never in the way: no question without a terminal, in scripts, or when the
 * check cannot reach GitHub quickly.
 */
export async function offerUpdate(home: string): Promise<boolean> {
  if (envFlag('PHONECODE_NO_UPDATE_CHECK') || envFlag('PHONECODE_JSON') || envFlag('CI')) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const how = installKind();
  if (how.kind !== 'standalone') return false;

  const file = join(home, 'update.json');
  const saved = await readJson(file);
  const rec = isRecord(saved) ? saved : {};
  const state: UpdateState = {
    ...(typeof rec['checkedAt'] === 'number' ? { checkedAt: rec['checkedAt'] } : {}),
    ...(typeof rec['latest'] === 'string' ? { latest: rec['latest'] } : {}),
    ...(typeof rec['declined'] === 'string' ? { declined: rec['declined'] } : {}),
  };
  if (Date.now() - (state.checkedAt ?? 0) > CHECK_EVERY_MS) {
    const latest = await latestVersion();
    // An unreachable GitHub is tried again next time, not for another 12 hours.
    if (latest === undefined) return false;
    state.latest = latest;
    state.checkedAt = Date.now();
    await writeFileAtomic(file, JSON.stringify(state)).catch(() => undefined);
  }
  const latest = state.latest;
  if (latest === undefined || !isNewer(latest, DAEMON_VERSION)) return false;
  if (state.declined === latest) {
    process.stdout.write(`phonecode ${latest} is available: run \`phonecode update\`.\n\n`);
    return false;
  }
  const answer = (
    await ask(`phonecode ${latest} is available (this is ${DAEMON_VERSION}). Update now? [Y/n] `)
  )
    .trim()
    .toLowerCase();
  if (answer !== '' && answer !== 'y' && answer !== 'yes') {
    state.declined = latest;
    await writeFileAtomic(file, JSON.stringify(state)).catch(() => undefined);
    process.stdout.write('Not now. Later: `phonecode update`.\n\n');
    return false;
  }
  try {
    if (await install(how.path, latest)) return true;
  } catch (err) {
    process.stderr.write(`Update failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.stdout.write('Starting the version you have.\n\n');
  return false;
}

/** Runs the freshly installed executable in place of this one; resolves with its exit code. */
export async function restart(argv: string[]): Promise<number> {
  const how = installKind();
  const path = how.kind === 'standalone' ? how.path : process.execPath;
  const proc = Bun.spawn([path, ...argv], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PHONECODE_NO_UPDATE_CHECK: '1' },
  });
  // Ctrl+C at the terminal reaches both processes: the new one shuts down and this
  // one waits for it. A signal sent to this process alone is passed on.
  process.on('SIGINT', () => {});
  for (const s of ['SIGTERM', 'SIGHUP'] as const) process.on(s, () => proc.kill(s));
  return proc.exited;
}
